/**
 * 打包脚本防回归测试（1.83.1）：
 *
 * 1.82.0 的教训——Release CI 实际使用 build-deb-ci.sh / build-rpm-ci.sh，
 * 而特权更新辅助三件套只加进了 .deb-inner.sh / .rpm-inner.sh（本机打包路径），
 * 导致发布包缺少 helper 单元，一键更新权限预检恒为 denied。
 * 本测试锁定：所有打包脚本都必须包含三件套引用。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const PACKAGING_DIR = path.join(__dirname, '..', '..', 'packaging', 'linux');
const MARKERS = ['apply-update.sh', 'docker-manager-update.service', '45-docker-manager-update.rules'];

/** deb/rpm 的四种打包脚本（CI 与本机两条路径）必须全部引用 helper 三件套 */
const SCRIPTS = ['build-deb-ci.sh', 'build-rpm-ci.sh', '.deb-inner.sh', '.rpm-inner.sh'];

for (const script of SCRIPTS) {
  test(`打包脚本 ${script} 包含特权更新辅助三件套引用`, () => {
    const src = fs.readFileSync(path.join(PACKAGING_DIR, script), 'utf8');
    for (const marker of MARKERS) {
      assert.ok(src.includes(marker), `${script} 缺少 ${marker} —— 特权更新辅助将不会随包安装`);
    }
  });
}

test('helper 单元指向 root 安装脚本固定路径', () => {
  const unit = fs.readFileSync(path.join(PACKAGING_DIR, 'docker-manager-update.service'), 'utf8');
  assert.match(unit, /ExecStart=\/opt\/docker-manager\/sbin\/apply-update\.sh/);
  assert.doesNotMatch(unit, /User=/, 'helper 必须以默认 root 运行（显式 User=root 亦无必要）');
});

test('polkit 规则精确授权 dockerman 仅能操作 helper 单元', () => {
  const rules = fs.readFileSync(path.join(PACKAGING_DIR, '45-docker-manager-update.rules'), 'utf8');
  assert.match(rules, /subject\.user == "dockerman"/);
  assert.match(rules, /action\.lookup\("unit"\) == "docker-manager-update\.service"/);
});
