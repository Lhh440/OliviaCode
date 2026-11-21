// OliviaCode 安装器（离线、单文件、内嵌 ZIP 载荷）。
//
// 为什么手写：仓库里没有 electron-builder / NSIS，网络也装不了依赖；
// Windows 自带 csc + System.IO.Compression 足够做一个正经的安装器：
//   - 选安装目录（默认 %LOCALAPPDATA%\OliviaCode）
//   - 解压载荷、显示进度
//   - 建开始菜单与桌面快捷方式
//   - 写 HKCU 卸载项（指向随装的 uninstall.ps1）
//
// 编译：csc /target:winexe /codepage:65001 /win32icon:build\icon.ico
//        /resource:payload.zip OliviaInstaller.cs
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OliviaSetup
{
    internal static class AppInfo
    {
        public const string Product = "OliviaCode";
        public const string DisplayName = "OliviaCode0.1版";
        public const string Version = "0.10.0";
        public const string Publisher = "OliviaCode";
        public const string ExeName = "OliviaCode.exe";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\OliviaCode";
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // 装完之后由 uninstall.ps1 调回来也可以走这条路：/uninstall <目录>
            if (args.Length > 0 && args[0].Equals("/uninstall", StringComparison.OrdinalIgnoreCase))
            {
                Uninstaller.Run(args.Length > 1 ? args[1] : Launcher.DefaultDir());
                return;
            }

            // 给自动化用：只把载荷解出来，不起界面（打包自检靠它验证载荷完整）
            if (args.Length > 0 && args[0].Equals("/extract", StringComparison.OrdinalIgnoreCase))
            {
                var target = args.Length > 1 ? args[1] : Launcher.DefaultDir();
                var count = Payload.Extract(target, (done, total, name) =>
                {
                    if (done == total) Console.WriteLine("extracted " + done + "/" + total + " files");
                });
                Console.WriteLine("ok " + count);
                return;
            }

            // 给自动化用：走一遍完整安装（解压 + 快捷方式 + 卸载项），但不起界面
            if (args.Length > 0 && args[0].Equals("/install", StringComparison.OrdinalIgnoreCase))
            {
                var target = args.Length > 1 ? args[1] : Launcher.DefaultDir();
                var count = Payload.Extract(target, null);
                var exe = Path.Combine(target, AppInfo.ExeName);
                Shortcuts.Create(
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs",
                        AppInfo.DisplayName + ".lnk"), exe, exe);
                Uninstaller.WriteScript(target);
                Uninstaller.Register(target);
                Console.WriteLine("installed " + count + " files into " + target);
                return;
            }

            Application.Run(new SetupForm());
        }
    }

    internal static class Launcher
    {
        public static string DefaultDir()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                AppInfo.Product);
        }

        public static void Open(string path)
        {
            try
            {
                // 不用 UseShellExecute：要显式清掉 ELECTRON_RUN_AS_NODE，
                // 否则在某些开发机环境里 Electron 会退化成纯 Node 进程，窗口一闪就没了。
                var info = new ProcessStartInfo
                {
                    FileName = path,
                    WorkingDirectory = Path.GetDirectoryName(path),
                    UseShellExecute = false,
                };
                info.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                info.EnvironmentVariables.Remove("ELECTRON_NO_ATTACH_CONSOLE");
                Process.Start(info);
            }
            catch
            {
                // 打不开就算了，安装本身已经完成
            }
        }
    }

    internal static class Shortcuts
    {
        public static void Create(string linkPath, string target, string iconPath)
        {
            var directory = Path.GetDirectoryName(linkPath);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            var type = Type.GetTypeFromProgID("WScript.Shell");
            if (type == null) return;
            dynamic shell = Activator.CreateInstance(type);
            dynamic link = shell.CreateShortcut(linkPath);
            link.TargetPath = target;
            link.WorkingDirectory = Path.GetDirectoryName(target);
            link.IconLocation = iconPath + ",0";
            link.Description = AppInfo.DisplayName;
            link.Save();
        }
    }

    internal static class Payload
    {
        public static int Extract(string targetDir, Action<int, int, string> progress)
        {
            var assembly = Assembly.GetExecutingAssembly();
            var name = assembly.GetManifestResourceNames()
                .FirstOrDefault(item => item.EndsWith("payload.zip", StringComparison.OrdinalIgnoreCase));
            if (name == null)
                throw new InvalidOperationException("安装包里没有找到载荷（payload.zip），这个 exe 可能被截断了。");

            using (var stream = assembly.GetManifestResourceStream(name))
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                var entries = zip.Entries.Where(entry => !string.IsNullOrEmpty(entry.Name) || entry.FullName.EndsWith("/")).ToList();
                var total = entries.Count;
                Directory.CreateDirectory(targetDir);
                var done = 0;
                foreach (var entry in entries)
                {
                    var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    var destination = Path.GetFullPath(Path.Combine(targetDir, relative));
                    if (!destination.StartsWith(Path.GetFullPath(targetDir), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("载荷里有越界的路径：" + entry.FullName);

                    if (entry.FullName.EndsWith("/"))
                    {
                        Directory.CreateDirectory(destination);
                    }
                    else
                    {
                        var folder = Path.GetDirectoryName(destination);
                        if (!string.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
                        entry.ExtractToFile(destination, true);
                    }

                    done += 1;
                    if (progress != null) progress(done, total, entry.FullName);
                }
                return done;
            }
        }
    }

    internal static class Uninstaller
    {
        public static void Run(string dir)
        {
            var answer = MessageBox.Show(
                "要从这台电脑上卸载 " + AppInfo.DisplayName + " 吗？\r\n\r\n" +
                "卸载只删除程序文件，任务记录、提供商配置与用量账本保留在 %APPDATA% 里。",
                AppInfo.DisplayName,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;

            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(AppInfo.UninstallKey, false);
            }
            catch
            {
                // 注册表项不存在也无所谓
            }

            var startMenu = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", AppInfo.DisplayName + ".lnk");
            TryDelete(startMenu);
            var desktop = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppInfo.DisplayName + ".lnk");
            TryDelete(desktop);

            // 自己删不掉自己：交给 cmd 等进程退出后清理目录
            var command = "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"" + dir + "\"";
            Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = command,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden,
            });
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // 删不掉就留着，不影响主流程
            }
        }

        /// <summary>随安装落一份卸载脚本，给「添加/删除程序」用。</summary>
        public static string WriteScript(string dir)
        {
            var exe = Path.Combine(dir, AppInfo.ExeName);
            var script = Path.Combine(dir, "uninstall.ps1");
            var content =
                "# 由 " + AppInfo.DisplayName + " 安装器生成。\r\n" +
                "$ErrorActionPreference = 'SilentlyContinue'\r\n" +
                "$dir = '" + dir.Replace("'", "''") + "'\r\n" +
                "Remove-Item (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\" + AppInfo.DisplayName + ".lnk') -Force\r\n" +
                "Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) '" + AppInfo.DisplayName + ".lnk') -Force\r\n" +
                "Remove-Item 'HKCU:\\" + AppInfo.UninstallKey + "' -Recurse -Force\r\n" +
                "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','ping 127.0.0.1 -n 3 >nul & rmdir /s /q \"' + $dir + '\"' -WindowStyle Hidden\r\n";
            File.WriteAllText(script, content, new UTF8Encoding(true));
            return exe;
        }

        public static void Register(string dir)
        {
            var exe = Path.Combine(dir, AppInfo.ExeName);
            var script = Path.Combine(dir, "uninstall.ps1");
            using (var key = Registry.CurrentUser.CreateSubKey(AppInfo.UninstallKey))
            {
                if (key == null) return;
                key.SetValue("DisplayName", AppInfo.DisplayName);
                key.SetValue("DisplayVersion", AppInfo.Version);
                key.SetValue("Publisher", AppInfo.Publisher);
                key.SetValue("InstallLocation", dir);
                key.SetValue("DisplayIcon", exe);
                key.SetValue("UninstallString",
                    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                try
                {
                    var size = new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
                    key.SetValue("EstimatedSize", (int)(size / 1024), RegistryValueKind.DWord);
                }
                catch
                {
                    // 体积只是锦上添花
                }
            }
        }
    }
}
