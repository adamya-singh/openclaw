// Root Package Overrides tests cover root package overrides script behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

type RootPackageManifest = {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

type PnpmWorkspaceConfig = {
  overrides?: Record<string, string>;
  allowedDeprecatedVersions?: Record<string, string>;
};

type PnpmLockfileConfig = {
  overrides?: Record<string, string>;
};

function readRootManifest(): RootPackageManifest {
  const manifestPath = path.resolve(process.cwd(), "package.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RootPackageManifest;
}

function readPnpmWorkspaceConfig(): PnpmWorkspaceConfig {
  const workspacePath = path.resolve(process.cwd(), "pnpm-workspace.yaml");
  return YAML.parse(fs.readFileSync(workspacePath, "utf8")) as PnpmWorkspaceConfig;
}

function readPnpmLockfileConfig(): PnpmLockfileConfig {
  const lockfilePath = path.resolve(process.cwd(), "pnpm-lock.yaml");
  return YAML.parse(fs.readFileSync(lockfilePath, "utf8")) as PnpmLockfileConfig;
}

function readPackageManifest(packagePath: string): RootPackageManifest {
  return JSON.parse(fs.readFileSync(packagePath, "utf8")) as RootPackageManifest;
}

describe("root package override guardrails", () => {
  it("keeps Bedrock runtime ownership in the Amazon provider plugin", () => {
    const manifest = readRootManifest();
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const packageName = "@aws-sdk/client-bedrock-runtime";
    const bedrockManifest = readPackageManifest(
      path.resolve(process.cwd(), "extensions", "amazon-bedrock", "package.json"),
    );
    const bedrockRuntimeDependency = bedrockManifest.dependencies?.[packageName];
    const npmOverride = manifest.overrides?.[packageName];

    expect(bedrockRuntimeDependency).toBeDefined();
    expect(manifest.dependencies).not.toHaveProperty(packageName);
    expect(npmOverride).toBeUndefined();
    expect(pnpmWorkspace.overrides).not.toHaveProperty(packageName);
  });

  it("keeps node-domexception importable from ESM instead of aliasing it away", async () => {
    // fetch-blob/formdata-node (via node-fetch@3 -> gaxios -> google-auth-library) default-import
    // this package from ESM; the @nolyfill alias exports `undefined` there and every Google
    // service-account token mint fails under Vitest/tsx. Mute the deprecation, keep the module.
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const domExceptionModule = await import("node-domexception");

    expect(pnpmWorkspace.overrides).not.toHaveProperty("node-domexception");
    expect(pnpmWorkspace.allowedDeprecatedVersions?.["node-domexception"]).toBe("1");
    expect(domExceptionModule.default).toBe(globalThis.DOMException);
    await expect(import("node-fetch")).resolves.toBeDefined();
  });

  it("keeps pnpm and lockfile override metadata aligned without duplicating root package policy", () => {
    const manifest = readRootManifest();
    const pnpmWorkspace = readPnpmWorkspaceConfig();
    const pnpmLockfile = readPnpmLockfileConfig();

    expect(manifest.overrides).toBeUndefined();
    expect(pnpmLockfile.overrides).toEqual(pnpmWorkspace.overrides);
  });
});
