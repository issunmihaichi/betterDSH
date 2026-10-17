"""Pack/verify six portable bundles and create an install-ready ZIP.

Uses the caller's existing Node and pnpm; does not install, publish, delete,
modify a profile, or include arbitrary workspace files. Python stdlib only.
"""
from argparse import ArgumentParser
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path, PurePosixPath
import json
import posixpath
import re
import subprocess
import tarfile
import zipfile

PLUGINS = ("dsh-usage-report", "dsh-account-pool", "dsh-context-window", "dsh-github", "dsh-mcp-skills", "dsh-installer")
ROOT = Path(__file__).resolve().parents[1]


def export_paths(value):
    if isinstance(value, str):
        return [value] if value.startswith("./") else []
    if isinstance(value, dict):
        return [path for child in value.values() for path in export_paths(child)]
    return []


def verify(directory, archive):
    source_manifest = json.loads((directory / "package.json").read_text("utf-8"))
    with tarfile.open(archive, "r:gz") as tar:
        members = {}
        for member in tar.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or path.parts[0] != "package":
                raise ValueError(f"Unsafe package path: {member.name}")
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"Non-regular package entry: {member.name}")
            relative = path.relative_to("package").as_posix()
            if any(part in {"node_modules", "refs", ".git"} for part in path.parts):
                raise ValueError(f"Unexpected private/dependency path: {member.name}")
            if relative in members:
                raise ValueError(f"Duplicate entry: {member.name}")
            content = tar.extractfile(member).read()
            # pnpm reorders package.json fields when packing. Validate its full
            # parsed semantics below; all other shipped files must match bytes.
            if relative != "package.json" and content != (directory / relative).read_bytes():
                raise ValueError(f"Package differs from source: {directory.name}/{relative}")
            members[relative] = content
    manifest = json.loads(members["package.json"])
    if manifest != source_manifest:
        raise ValueError(f"Stale manifest: {archive.name}")
    entries = [manifest["main"], manifest["dsh"]["bundle"]["patch"], *export_paths(manifest.get("exports"))]
    for entry in entries:
        path = entry.removeprefix("./")
        if "*" in path:
            pattern = re.compile("^" + re.escape(path).replace(r"\*", "[^/]*") + "$")
            if not any(pattern.match(member) for member in members):
                raise ValueError(f"Empty export pattern: {path}")
        elif path not in members:
            raise ValueError(f"Missing entry: {path}")
    for path, content in members.items():
        if not path.endswith((".js", ".mjs")):
            continue
        source = content.decode("utf-8")
        specs = re.findall(r"(?:from\s*|import\s*\()\s*['\"`](\.[^'\"`]+)['\"`]", source)
        for spec in specs:
            filename = re.split(r"[?#]", spec)[0]
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), filename))
            if "${" in filename or target not in members:
                raise ValueError(f"Missing relative import: {path} -> {spec}")
    patch = members[manifest["dsh"]["bundle"]["patch"].removeprefix("./")].decode("utf-8")
    if re.search(r"^\s+name:\s+(?:[A-Za-z]:[/\\]|/)", patch, re.MULTILINE):
        raise ValueError("Absolute loader path in release patch")
    return manifest, members


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True, type=Path, help="Existing Node executable")
    parser.add_argument("--pnpm", required=True, type=Path, help="Existing pnpm CLI .mjs")
    parser.add_argument("--out", type=Path, default=ROOT.parent / "betterDSH-packages")
    parser.add_argument("--zip", type=Path, default=ROOT.parent / "betterDSH-plugin-packages.zip")
    args = parser.parse_args()
    out, zip_path = args.out.resolve(), args.zip.resolve()
    if not args.node.is_file() or not args.pnpm.is_file():
        parser.error("Use existing Node and pnpm paths; no dependency installer is run.")
    out.mkdir(parents=True, exist_ok=True)
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    records, verified = [], []
    for name in PLUGINS:
        directory = ROOT / name
        manifest = json.loads((directory / "package.json").read_text("utf-8"))
        if manifest["name"] != name:
            raise ValueError(f"Unexpected package identity: {name}")
        # Avoid implicit lifecycle scripts when packing our own portable bundles.
        if any(hook in manifest.get("scripts", {}) for hook in ("prepack", "prepare", "postpack")):
            raise ValueError(f"Review pack lifecycle scripts explicitly: {name}")
        subprocess.run([str(args.node.resolve()), str(args.pnpm.resolve()), "pack", "--pack-destination", str(out)], cwd=directory, check=True)
        archive = out / f"{name}-{manifest['version']}.tgz"
        packed, members = verify(directory, archive)
        records.append({"name": name, "version": packed["version"], "archive": archive.name, "sha256": sha256(archive.read_bytes()).hexdigest(), "files": len(members)})
        verified.append((name, archive, members))
        print(f"PACK VERIFIED {archive.name}: {len(members)} matching files, imports and exports complete", flush=True)
    metadata = {"createdAt": datetime.now(timezone.utc).isoformat(), "bundles": records, "validation": "source bytes (package.json semantic equality), identity, entries, exports, relative imports, portable patch; not a signature or live installation test"}
    metadata_text = json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"
    (out / "release-manifest.json").write_text(metadata_text, encoding="utf-8")
    instructions = """# betterDSH 六插件 UX 改进包

本 ZIP 同时提供六个 `.tgz` 和已展开的 `plugins/` 运行目录。只包含发行内容，不包含测试依赖、真实配置或凭据。

1. 将 ZIP **完整解压**到可信且不会临时删除的目录。
2. 在 DSH 官方插件管理器安装 `plugins/dsh-installer` 的**绝对路径**并启用。如提示需要重启，请手动重启。
3. 在「插件 → dsh-installer → 配置详情」将仓库路径设为解压目录中 `plugins` 的**绝对路径**。
4. 检查、勾选五个功能插件、预览并确认。安装可能下载声明的 npm 依赖。
5. 已有插件只启用/跳过，不覆盖更新；升级旧安装请在官方管理器单独处理。更新 Host 后重启 DSH，更新 Client 后刷新 GUI。

也可分别安装 `plugins/<插件名>` 目录。请勿将归档直接移动进 profile 或手写凭据。

- 包摘要/版本见 `release-manifest.json`；SHA256用于本地完整性核对，不是签名认证。
- UX目标见 `docs/UX-DESIGN.md`。
- 维护/完整测试请使用源码仓库： https://github.com/ISSunmihaichi/betterDSH 。本ZIP的运行目录不带 tools 测试脚本。
- 本轮完成离线回归与打包验证，未安装到当前GUI，未做真实浏览器/屏幕阅读器验收。
- 用量历史真实对账存在六条与投影缓存不一致，尚未修复；账号池等批量写入不提供跨请求事务回滚。
"""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zip_out:
        zip_out.writestr("INSTALL.md", instructions)
        zip_out.writestr("release-manifest.json", metadata_text)
        zip_out.writestr("docs/UX-DESIGN.md", (ROOT / "docs/UX-DESIGN.md").read_bytes())
        for name, archive, members in verified:
            zip_out.write(archive, archive.name)
            for path, content in sorted(members.items()):
                zip_out.writestr(f"plugins/{name}/{path}", content)
    with zipfile.ZipFile(zip_path) as zip_in:
        if zip_in.testzip() is not None:
            raise ValueError("ZIP CRC verification failed")
        for name, archive, members in verified:
            if zip_in.read(archive.name) != archive.read_bytes():
                raise ValueError("ZIP archive byte mismatch")
            for path, content in members.items():
                if zip_in.read(f"plugins/{name}/{path}") != content:
                    raise ValueError("ZIP expanded package mismatch")
    print(f"ZIP VERIFIED {zip_path}: exactly six current bundles, install-ready plugin directories, CRC and bytes match", flush=True)


if __name__ == "__main__":
    main()
