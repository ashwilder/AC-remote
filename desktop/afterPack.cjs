// Puts the AC Remote icon and version details into AC Remote.exe.
// (electron-builder normally does this with rcedit, which needs Windows or Wine; resedit is pure JavaScript.)
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== "win32") return;
    const ResEdit = await import("resedit");
    const { NtExecutable, NtExecutableResource, Resource, Data } = ResEdit;
    const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
    const version = context.packager.appInfo.version;

    const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
    const res = NtExecutableResource.from(exe);

    const iconFile = Data.IconFile.from(fs.readFileSync(path.join(__dirname, "icon.ico")));
    const groups = Resource.IconGroupEntry.fromEntries(res.entries);
    const iconId = groups.length ? groups[0].id : 1;
    const lang = groups.length ? groups[0].lang : 1033;
    Resource.IconGroupEntry.replaceIconsForResource(res.entries, iconId, lang, iconFile.icons.map(i => i.data));

    const vis = Resource.VersionInfo.fromEntries(res.entries);
    const vi = vis[0] ?? Resource.VersionInfo.createEmpty();
    const [a, b, c] = version.split(".").map(Number);
    vi.setFileVersion(a, b, c, 0, 1033);
    vi.setProductVersion(a, b, c, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
        FileDescription: "AC Remote",
        ProductName: "AC Remote",
        CompanyName: "AC Remote",
        OriginalFilename: "AC Remote.exe",
        InternalName: "AC Remote",
        FileVersion: version,
        ProductVersion: version,
        LegalCopyright: "",
    });
    vi.outputToResourceEntries(res.entries);

    res.outputResource(exe);
    fs.writeFileSync(exePath, Buffer.from(exe.generate()));
    console.log(`  • set icon and version on ${path.basename(exePath)}`);
};
