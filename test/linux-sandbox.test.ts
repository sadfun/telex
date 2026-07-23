import { describe, expect, it, vi } from "vitest";
import { resolveCodexLaunch } from "../src/codex/linux-sandbox.js";

const baseOptions = {
  binaryPath: "/toolchain/codex",
  args: ["app-server", "--strict-config", "--listen", "stdio://"],
  cwd: "/workspace",
  env: { CODEX_HOME: "/codex-home" },
  platform: "linux",
} as const;

describe("Codex Linux sandbox compatibility", () => {
  it("uses Codex directly when its sandbox probe succeeds", async () => {
    const commandRunner = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await expect(resolveCodexLaunch({ ...baseOptions, commandRunner })).resolves.toEqual({
      executable: "/toolchain/codex",
      args: baseOptions.args,
    });
    expect(commandRunner).toHaveBeenCalledOnce();
  });

  it("uses the first AppArmor profile that fixes the bubblewrap userns failure", async () => {
    const commandRunner = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "/toolchain/codex exited with 1: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
        ),
      )
      .mockRejectedValueOnce(new Error("profile unavailable"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await expect(
      resolveCodexLaunch({
        ...baseOptions,
        commandRunner,
        aaExecPath: "/usr/bin/aa-exec",
        appArmorProfiles: ["rootlesskit", "podman"],
      }),
    ).resolves.toEqual({
      executable: "/usr/bin/aa-exec",
      args: [
        "-p",
        "podman",
        "--",
        "/toolchain/codex",
        "app-server",
        "--strict-config",
        "--listen",
        "stdio://",
      ],
      appArmorProfile: "podman",
    });
  });

  it("does not bypass unrelated Codex sandbox failures", async () => {
    const commandRunner = vi.fn().mockRejectedValue(new Error("invalid configuration"));

    await expect(resolveCodexLaunch({ ...baseOptions, commandRunner })).resolves.toEqual({
      executable: "/toolchain/codex",
      args: baseOptions.args,
    });
    expect(commandRunner).toHaveBeenCalledOnce();
  });

  it("does not probe on non-Linux platforms", async () => {
    const commandRunner = vi.fn();

    await expect(
      resolveCodexLaunch({ ...baseOptions, platform: "darwin", commandRunner }),
    ).resolves.toEqual({
      executable: "/toolchain/codex",
      args: baseOptions.args,
    });
    expect(commandRunner).not.toHaveBeenCalled();
  });
});
