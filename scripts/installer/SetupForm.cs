// 安装器的界面部分：一个窗口，选目录 → 解压 → 建快捷方式 → 完成。
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace OliviaSetup
{
    internal sealed class SetupForm : Form
    {
        private readonly TextBox _pathBox;
        private readonly CheckBox _desktopShortcut;
        private readonly CheckBox _launchAfter;
        private readonly ProgressBar _progress;
        private readonly Label _status;
        private readonly Button _installButton;
        private readonly Button _browseButton;
        private readonly Button _cancelButton;
        private bool _installing;

        public SetupForm()
        {
            Text = AppInfo.DisplayName;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 300);
            Font = new Font("Microsoft YaHei UI", 9F);
            BackColor = Color.FromArgb(242, 241, 236);
            AutoScaleMode = AutoScaleMode.Dpi;

            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
                // 没有图标也能装
            }

            var title = new Label
            {
                Text = "安装 " + AppInfo.DisplayName,
                Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold),
                ForeColor = Color.FromArgb(20, 22, 26),
                AutoSize = true,
                Location = new Point(24, 22),
            };
            Controls.Add(title);

            var subtitle = new Label
            {
                Text = "版本 " + AppInfo.Version + " · 本地优先的 AI 编程工作站\r\n安装会把程序文件放到下面的目录，任务记录与密钥仍留在你自己的用户目录里。",
                ForeColor = Color.FromArgb(86, 90, 97),
                AutoSize = false,
                Size = new Size(512, 52),
                Location = new Point(26, 62),
            };
            Controls.Add(subtitle);

            var pathLabel = new Label
            {
                Text = "安装位置",
                ForeColor = Color.FromArgb(86, 90, 97),
                AutoSize = true,
                Location = new Point(26, 124),
            };
            Controls.Add(pathLabel);

            _pathBox = new TextBox
            {
                Text = Launcher.DefaultDir(),
                Location = new Point(26, 146),
                Size = new Size(410, 26),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            };
            Controls.Add(_pathBox);

            _browseButton = new Button
            {
                Text = "浏览…",
                Location = new Point(446, 145),
                Size = new Size(88, 28),
            };
            _browseButton.Click += OnBrowse;
            Controls.Add(_browseButton);

            _desktopShortcut = new CheckBox
            {
                Text = "创建桌面快捷方式",
                Checked = true,
                AutoSize = true,
                Location = new Point(26, 186),
            };
            Controls.Add(_desktopShortcut);

            _launchAfter = new CheckBox
            {
                Text = "安装完成后启动",
                Checked = true,
                AutoSize = true,
                Location = new Point(220, 186),
            };
            Controls.Add(_launchAfter);

            _progress = new ProgressBar
            {
                Location = new Point(26, 220),
                Size = new Size(508, 10),
                Style = ProgressBarStyle.Continuous,
            };
            Controls.Add(_progress);

            _status = new Label
            {
                Text = "准备就绪。",
                ForeColor = Color.FromArgb(86, 90, 97),
                AutoSize = false,
                Size = new Size(508, 20),
                Location = new Point(26, 236),
            };
            Controls.Add(_status);

            _installButton = new Button
            {
                Text = "安装",
                Location = new Point(352, 262),
                Size = new Size(88, 30),
            };
            _installButton.Click += OnInstall;
            Controls.Add(_installButton);

            _cancelButton = new Button
            {
                Text = "取消",
                Location = new Point(446, 262),
                Size = new Size(88, 30),
            };
            _cancelButton.Click += (sender, args) => Close();
            Controls.Add(_cancelButton);

            AcceptButton = _installButton;
            CancelButton = _cancelButton;
        }

        private void OnBrowse(object sender, EventArgs e)
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择安装目录";
                dialog.ShowNewFolderButton = true;
                if (Directory.Exists(_pathBox.Text)) dialog.SelectedPath = _pathBox.Text;
                if (dialog.ShowDialog(this) == DialogResult.OK) _pathBox.Text = dialog.SelectedPath;
            }
        }

        private void OnInstall(object sender, EventArgs e)
        {
            if (_installing) return;

            var target = _pathBox.Text.Trim();
            if (target.Length == 0)
            {
                MessageBox.Show(this, "先选一个安装目录。", AppInfo.DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                target = Path.GetFullPath(target);
                Directory.CreateDirectory(target);
                var probe = Path.Combine(target, ".olivia-write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
            }
            catch (Exception error)
            {
                MessageBox.Show(this, "这个目录写不进去：" + error.Message, AppInfo.DisplayName,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            if (Directory.Exists(Path.Combine(target, "resources")) &&
                MessageBox.Show(this, "这个目录里已经有一份 OliviaCode，覆盖安装吗？", AppInfo.DisplayName,
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            {
                return;
            }

            _installing = true;
            _installButton.Enabled = false;
            _browseButton.Enabled = false;
            _cancelButton.Text = "关闭";
            _pathBox.Enabled = false;

            var worker = new Thread(() => Install(target)) { IsBackground = true };
            worker.Start();
        }

        private void Install(string target)
        {
            try
            {
                SetStatus("正在解压程序文件…");
                var count = Payload.Extract(target, (done, total, name) =>
                {
                    if (done % 8 != 0 && done != total) return;
                    var percent = total == 0 ? 0 : (int)Math.Round(done * 100.0 / total);
                    BeginInvoke(new Action(() =>
                    {
                        _progress.Value = Math.Min(100, Math.Max(0, percent));
                        SetStatus(string.Format("正在解压 {0}/{1}：{2}", done, total, Short(name)));
                    }));
                });

                SetStatus("正在创建快捷方式…");
                var exe = Path.Combine(target, AppInfo.ExeName);
                var startMenu = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", AppInfo.DisplayName + ".lnk");
                Shortcuts.Create(startMenu, exe, exe);
                if (_desktopShortcut.Checked)
                {
                    var desktop = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppInfo.DisplayName + ".lnk");
                    Shortcuts.Create(desktop, exe, exe);
                }

                SetStatus("正在登记卸载信息…");
                Uninstaller.WriteScript(target);
                Uninstaller.Register(target);

                BeginInvoke(new Action(() =>
                {
                    _progress.Value = 100;
                    SetStatus(string.Format("装好了：{0} 个文件。", count));
                    _cancelButton.Text = "关闭";
                    _installButton.Text = "完成";
                    _installButton.Enabled = true;
                    _installButton.Click -= OnInstall;
                    _installButton.Click += (s, a) =>
                    {
                        if (_launchAfter.Checked) Launcher.Open(exe);
                        Close();
                    };
                }));
            }
            catch (Exception error)
            {
                BeginInvoke(new Action(() =>
                {
                    _installing = false;
                    _installButton.Enabled = true;
                    _browseButton.Enabled = true;
                    _pathBox.Enabled = true;
                    SetStatus("安装失败：" + error.Message);
                    MessageBox.Show(this, "安装没完成：\r\n" + error, AppInfo.DisplayName,
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                }));
            }
        }

        private static string Short(string name)
        {
            if (name.Length <= 46) return name;
            return "…" + name.Substring(name.Length - 45);
        }

        private void SetStatus(string text)
        {
            if (_status.InvokeRequired)
            {
                _status.BeginInvoke(new Action(() => _status.Text = text));
                return;
            }
            _status.Text = text;
        }
    }
}
