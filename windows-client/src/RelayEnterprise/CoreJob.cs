using Microsoft.Win32.SafeHandles;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace RelayEnterprise;

// Windows closes the job handle on client termination, including a crash.
// The kernel then stops the core even if the managed cleanup cannot run.
public sealed class CoreJob : IDisposable
{
    readonly SafeFileHandle handle;
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public nuint MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public nuint Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public nuint ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateJobObjectW(nint attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(SafeFileHandle job, int information, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(SafeFileHandle job, nint process);
    CoreJob()
    {
        handle = CreateJobObjectW(0, null);
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 } };
        if (handle.IsInvalid || !SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()))
        { handle.Dispose(); throw new ClientFailure("无法建立代理核心退出保护。"); }
    }
    public static CoreJob? Create() => OperatingSystem.IsWindows() ? new() : null;
    public void Attach(Process core)
    {
        if (!AssignProcessToJobObject(handle, core.Handle)) throw new ClientFailure("无法绑定代理核心退出保护。");
    }
    public void Dispose() => handle.Dispose();
}
