/*
 * DockerManager 系统托盘程序
 *
 * 提供系统托盘图标，便于用户快速打开面板、查看服务状态、优雅控制。
 * 编译目标: .NET Framework 4.0 (csc v4.0.30319)
 * 编译命令:
 *   csc /target:winexe /out:TrayApp.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll TrayApp.cs
 *
 * 注意：该托盘程序为普通用户态程序（Windows 服务本身无法显示交互 UI），
 * 通过启动文件夹实现开机自启，提供快捷入口。
 */
using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace DockerManager
{
    /// <summary>
    /// 托盘程序主类，承载图标与右键菜单。
    /// </summary>
    internal static class TrayApp
    {
        // 面板地址（与后端监听端口一致，默认 9528）
        private static readonly string PanelUrl = "http://localhost:9528/";
        // 服务名称
        private static readonly string ServiceName = "DockerManager";

        /// <summary>
        /// 程序入口：创建托盘图标并进入消息循环。
        /// </summary>
        [STAThread]
        private static void Main()
        {
            using (var icon = BuildIcon())
            using (var notifyIcon = new NotifyIcon())
            using (var menu = BuildMenu(notifyIcon))
            {
                notifyIcon.Icon = icon;
                notifyIcon.Text = "Docker 管理面板\n" + PanelUrl;
                notifyIcon.ContextMenuStrip = menu;
                notifyIcon.Visible = true;

                // 双击图标默认打开面板
                notifyIcon.DoubleClick += (s, e) => OpenPanel();

                Application.Run();
                notifyIcon.Visible = false;
            }
        }

        /// <summary>
        /// 构建一个简单的托盘图标（蓝色方块 + D 字母）。
        /// </summary>
        private static Icon BuildIcon()
        {
            using (var bmp = new Bitmap(16, 16))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Indigo);
                    using (var font = new Font("Arial", 9, FontStyle.Bold))
                    using (var brush = new SolidBrush(Color.White))
                    {
                        g.DrawString("D", font, brush, 2, 0);
                    }
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        /// <summary>
        /// 构建托盘右键菜单。
        /// </summary>
        private static ContextMenuStrip BuildMenu(NotifyIcon icon)
        {
            var menu = new ContextMenuStrip();

            var open = new ToolStripMenuItem("打开面板");
            open.Click += (s, e) => OpenPanel();
            menu.Items.Add(open);

            var start = new ToolStripMenuItem("启动服务");
            start.Click += (s, e) => ToggleService(true);
            menu.Items.Add(start);

            var stop = new ToolStripMenuItem("停止服务");
            stop.Click += (s, e) => ToggleService(false);
            menu.Items.Add(stop);

            menu.Items.Add(new ToolStripSeparator());

            var exit = new ToolStripMenuItem("退出托盘");
            exit.Click += (s, e) => Application.Exit();
            menu.Items.Add(exit);

            return menu;
        }

        /// <summary>
        /// 用默认浏览器打开面板地址。
        /// </summary>
        private static void OpenPanel()
        {
            try
            {
                Process.Start(PanelUrl);
            }
            catch (Exception ex)
            {
                MessageBox.Show("打开面板失败：" + ex.Message, "Docker 管理面板", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        /// <summary>
        /// 启动或停止 Windows 服务。
        /// </summary>
        /// <param name="start">true 启动服务，false 停止服务</param>
        private static void ToggleService(bool start)
        {
            var psi = new ProcessStartInfo("net", (start ? "start " : "stop ") + ServiceName)
            {
                UseShellExecute = false,
                CreateNoWindow = true
            };
            try
            {
                using (var p = Process.Start(psi))
                {
                    if (p != null) p.WaitForExit(15000);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("操作服务失败：" + ex.Message, "Docker 管理面板", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
    }
}
