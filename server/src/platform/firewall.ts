/**
 * 跨平台防火墙适配器
 *
 * 按优先级探测可用的防火墙工具：
 * - Windows：netsh advfirewall
 * - Linux：firewalld → ufw → iptables
 *
 * 提供统一的 check / addRule / deleteRule 接口，
 * 供 routes/firewall.ts 调用，避免平台判断散落到路由层。
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { isWindows, isLinux } from './detect';

const execAsync = promisify(exec);

export interface FirewallAdapter {
  name: string;
  check(): Promise<{ supported: boolean; writable: boolean; message?: string }>;
  addRule(port: number, proto: string): Promise<void>;
  deleteRule(port: number, proto: string): Promise<void>;
}

class NetshAdapter implements FirewallAdapter {
  name = 'netsh';

  async check() {
    try {
      await execAsync('netsh advfirewall show currentprofile', { windowsHide: true, maxBuffer: 1024 * 1024 });
      return { supported: true, writable: true };
    } catch (err: any) {
      const stderr = err?.stderr || err?.message || '';
      if (/requires elevation|拒绝访问|管理员/i.test(stderr)) {
        return { supported: true, writable: false, message: '需要管理员权限操作防火墙' };
      }
      return { supported: false, writable: false, message: stderr.trim() || 'netsh 不可用' };
    }
  }

  async addRule(port: number, proto: string): Promise<void> {
    const name = `DM-Port-${port}-${proto.toUpperCase()}`;
    try {
      await execAsync(
        `netsh advfirewall firewall add rule name="${name}" dir=in action=allow protocol=${proto.toUpperCase()} localport=${port}`,
        { windowsHide: true, maxBuffer: 1024 * 1024 },
      );
    } catch (err: any) {
      const stderr = err?.stderr || err?.message || '';
      if (/requires elevation|拒绝访问|管理员/i.test(stderr)) {
        throw new Error('需要管理员权限操作防火墙（请以管理员身份运行面板服务）');
      }
      throw new Error(stderr.trim() || 'netsh 添加规则失败');
    }
  }

  async deleteRule(port: number, proto: string): Promise<void> {
    const name = `DM-Port-${port}-${proto.toUpperCase()}`;
    try {
      await execAsync(`netsh advfirewall firewall delete rule name="${name}"`, {
        windowsHide: true, maxBuffer: 1024 * 1024,
      });
    } catch (err: any) {
      const stderr = err?.stderr || err?.message || '';
      throw new Error(stderr.trim() || 'netsh 删除规则失败');
    }
  }
}

class FirewalldAdapter implements FirewallAdapter {
  name = 'firewalld';

  async check() {
    try {
      await execAsync('firewall-cmd --state', { timeout: 5000 });
      return { supported: true, writable: true };
    } catch (err: any) {
      const stderr = err?.stderr || err?.message || '';
      if (/not running|FirewallD is not running/i.test(stderr)) {
        return { supported: false, writable: false, message: 'firewalld 未运行' };
      }
      if (/Permission denied/i.test(stderr)) {
        return { supported: true, writable: false, message: '需要 root 权限操作 firewalld' };
      }
      return { supported: false, writable: false, message: stderr.trim() || 'firewalld 不可用' };
    }
  }

  async addRule(port: number, proto: string): Promise<void> {
    await execAsync(`firewall-cmd --permanent --add-port=${port}/${proto}`, { timeout: 10000 });
    await execAsync('firewall-cmd --reload', { timeout: 15000 });
  }

  async deleteRule(port: number, proto: string): Promise<void> {
    await execAsync(`firewall-cmd --permanent --remove-port=${port}/${proto}`, { timeout: 10000 });
    await execAsync('firewall-cmd --reload', { timeout: 15000 });
  }
}

class UfwAdapter implements FirewallAdapter {
  name = 'ufw';

  async check() {
    try {
      const { stdout } = await execAsync('ufw status', { timeout: 5000 });
      const enabled = /active/i.test(stdout);
      if (!enabled) return { supported: true, writable: false, message: 'ufw 已安装但未启用' };
      return { supported: true, writable: true };
    } catch {
      return { supported: false, writable: false, message: 'ufw 不可用' };
    }
  }

  async addRule(port: number, proto: string): Promise<void> {
    await execAsync(`ufw allow ${port}/${proto}`, { timeout: 10000 });
  }

  async deleteRule(port: number, proto: string): Promise<void> {
    await execAsync(`ufw delete allow ${port}/${proto}`, { timeout: 10000 });
  }
}

class IptablesAdapter implements FirewallAdapter {
  name = 'iptables';

  async check() {
    try {
      await execAsync('iptables -L -n', { timeout: 5000 });
      return { supported: true, writable: true };
    } catch {
      return { supported: false, writable: false, message: 'iptables 不可用' };
    }
  }

  async addRule(port: number, proto: string): Promise<void> {
    await execAsync(`iptables -A INPUT -p ${proto} --dport ${port} -j ACCEPT`, { timeout: 10000 });
  }

  async deleteRule(port: number, proto: string): Promise<void> {
    await execAsync(`iptables -D INPUT -p ${proto} --dport ${port} -j ACCEPT`, { timeout: 10000 });
  }
}

let cachedAdapter: FirewallAdapter | null = null;

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const cp = require('child_process');
    const check = cp.execSync(
      process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`,
      { timeout: 3000, stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

export async function getFirewallAdapter(): Promise<FirewallAdapter | null> {
  if (cachedAdapter) return cachedAdapter;

  if (isWindows()) {
    cachedAdapter = new NetshAdapter();
    return cachedAdapter;
  }

  if (isLinux()) {
    if (await commandExists('firewall-cmd')) {
      cachedAdapter = new FirewalldAdapter();
      return cachedAdapter;
    }
    if (await commandExists('ufw')) {
      cachedAdapter = new UfwAdapter();
      return cachedAdapter;
    }
    if (await commandExists('iptables')) {
      cachedAdapter = new IptablesAdapter();
      return cachedAdapter;
    }
  }

  return null;
}

export function resetFirewallCache(): void {
  cachedAdapter = null;
}
