using System;
using System.IO;
using System.Diagnostics;
using System.Text;
class Launcher {
    // Windows CommandLineToArgvW quoting; no shell interpolation.
    static string Quote(string value) {
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); }
            else { b.Append('\\', slashes); b.Append(c); }
            slashes = 0;
        }
        b.Append('\\', slashes * 2); return b.Append('"').ToString();
    }
    static int Main(string[] args) {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        var command = new StringBuilder(Quote(Path.Combine(root, "src", "cli.js")));
        foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        try {
            var info = new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), command.ToString());
            info.UseShellExecute = false;
            using (var p = Process.Start(info)) { p.WaitForExit(); return p.ExitCode; }
        } catch (Exception e) { Console.Error.WriteLine("aster-sim: " + e.Message); return 1; }
    }
}
