import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const sharedPath = path.join(root, "packages", "shared", "package.json");
const dingtalkPath = path.join(root, "extensions", "dingtalk", "package.json");
const channelsPath = path.join(root, "packages", "channels", "package.json");

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function bumpPatch(version) {
  const parts = version.split(".");
  if (parts.length !== 3) {
    throw new Error(`Invalid version: ${version}`);
  }
  const [major, minor, patch] = parts.map((p) => Number(p));
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new Error(`Invalid version: ${version}`);
  }
  return `${major}.${minor}.${patch + 1}`;
}

function run(cmd, cwd = root) {
  execSync(cmd, { stdio: "inherit", cwd });
}

const sharedPkg = readJson(sharedPath);
const dingtalkPkg = readJson(dingtalkPath);
const channelsPkg = readJson(channelsPath);

const originalShared = readJson(sharedPath);
const originalDingtalk = readJson(dingtalkPath);
const originalChannels = readJson(channelsPath);

const nextShared = bumpPatch(sharedPkg.version);
const nextDingtalk = bumpPatch(dingtalkPkg.version);
const nextChannels = bumpPatch(channelsPkg.version);

sharedPkg.version = nextShared;
sharedPkg.private = false;

dingtalkPkg.version = nextDingtalk;
dingtalkPkg.dependencies = dingtalkPkg.dependencies ?? {};
dingtalkPkg.dependencies["@openclaw-china/shared"] = nextShared;

channelsPkg.version = nextChannels;
channelsPkg.dependencies = channelsPkg.dependencies ?? {};
channelsPkg.dependencies["@openclaw-china/dingtalk"] = nextDingtalk;

writeJson(sharedPath, sharedPkg);
writeJson(dingtalkPath, dingtalkPkg);
writeJson(channelsPath, channelsPkg);

run("pnpm -F @openclaw-china/shared build");
run("pnpm -F @openclaw-china/dingtalk build");
run("pnpm -F @openclaw-china/channels build");

run("npm publish --access public", path.join(root, "packages", "shared"));
run("npm publish --access public", path.join(root, "extensions", "dingtalk"));
run("npm publish --access public", path.join(root, "packages", "channels"));

// Restore workspace dependencies for local development
if (originalDingtalk.dependencies) {
  originalDingtalk.dependencies["@openclaw-china/shared"] =
    originalDingtalk.dependencies["@openclaw-china/shared"] ?? "workspace:*";
}
if (originalChannels.dependencies) {
  originalChannels.dependencies["@openclaw-china/dingtalk"] =
    originalChannels.dependencies["@openclaw-china/dingtalk"] ?? "workspace:*";
}

writeJson(sharedPath, originalShared);
writeJson(dingtalkPath, originalDingtalk);
writeJson(channelsPath, originalChannels);
