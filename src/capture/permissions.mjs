import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync as spawnSyncDefault } from "node:child_process";

export const screenCaptureSettingsUrl = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export function requestScreenCapturePermission(options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnSync = options.spawnSync ?? spawnSyncDefault;
  const openSettings = options.openSettings !== false;
  const requestAccess = options.requestAccess !== false;
  const tmpDir = options.tmpDir ?? os.tmpdir();

  if (platform !== "darwin") {
    return {
      ok: false,
      state: "unsupported",
      settingsOpened: false,
      message: "Screen Recording permission requests are only supported on macOS."
    };
  }

  const request = requestAccess
    ? requestCoreGraphicsScreenCaptureAccess(spawnSync)
    : { ok: false, attempted: false, available: false, message: "CoreGraphics request skipped." };
  const probe = probeScreencapture({ spawnSync, tmpDir });

  if (probe.ok) {
    return {
      ok: true,
      state: "granted",
      request,
      probe,
      settingsOpened: false,
      message: "Screen Recording permission is available. A temporary permission probe frame was captured and deleted."
    };
  }

  const settings = openSettings ? openScreenRecordingSettings(spawnSync) : { opened: false, message: "Settings open skipped." };

  return {
    ok: false,
    state: "needs_manual_grant",
    request,
    probe,
    settingsOpened: settings.opened,
    message: [
      "Screen Recording permission is not available for this execution context.",
      request.message,
      probe.message,
      settings.message,
      "Grant Screen Recording permission to the app running Lucille, such as Codex, Terminal, iTerm, or VS Code. Quit and reopen that app after granting permission, then rerun the capture command."
    ].filter(Boolean).join("\n")
  };
}

function requestCoreGraphicsScreenCaptureAccess(spawnSync) {
  const swift = [
    "import CoreGraphics",
    "import Darwin",
    "if CGPreflightScreenCaptureAccess() {",
    "  print(\"granted\")",
    "  exit(0)",
    "}",
    "let granted = CGRequestScreenCaptureAccess()",
    "print(granted ? \"granted\" : \"not_granted\")",
    "exit(granted ? 0 : 2)"
  ].join("\n");

  const result = spawnSync("swift", ["-e", swift], {
    encoding: "utf8",
    timeout: 20_000
  });

  if (result.error) {
    return {
      ok: false,
      attempted: true,
      available: false,
      message: `CoreGraphics permission request unavailable: ${result.error.message}.`
    };
  }

  const output = compactOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const ok = result.status === 0 && /\bgranted\b/.test(output);

  return {
    ok,
    attempted: true,
    available: true,
    message: ok
      ? "CoreGraphics reports Screen Recording permission is granted."
      : `CoreGraphics requested Screen Recording permission but it is not granted yet${output ? ` (${output})` : ""}.`
  };
}

function probeScreencapture({ spawnSync, tmpDir }) {
  const probeDir = mkdtempSync(path.join(tmpDir, "lucille-screen-permission-"));
  const outputPath = path.join(probeDir, "probe.png");

  try {
    const result = spawnSync("screencapture", ["-x", outputPath], {
      encoding: "utf8",
      timeout: 20_000
    });

    if (result.error) {
      return {
        ok: false,
        message: `screencapture probe failed: ${result.error.message}.`
      };
    }

    const wroteFrame = existsSync(outputPath) && statSync(outputPath).size > 0;
    if (result.status === 0 && wroteFrame) {
      return {
        ok: true,
        message: "screencapture probe succeeded."
      };
    }

    const detail = compactOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return {
      ok: false,
      message: `screencapture probe did not produce a frame${detail ? `: ${detail}` : ""}.`
    };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function openScreenRecordingSettings(spawnSync) {
  const result = spawnSync("open", [screenCaptureSettingsUrl], {
    encoding: "utf8",
    timeout: 10_000
  });

  if (result.error || result.status !== 0) {
    const detail = compactOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) || result.error?.message;
    return {
      opened: false,
      message: `Could not open System Settings automatically${detail ? `: ${detail}` : ""}. Open Privacy & Security > Screen Recording manually.`
    };
  }

  return {
    opened: true,
    message: "Opened System Settings to Privacy & Security > Screen Recording."
  };
}

function compactOutput(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}
