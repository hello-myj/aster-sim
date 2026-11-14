"""Build a self-contained native Windows simulator; no firmware checkout at runtime."""
import hashlib,json,shutil,subprocess,sys,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    if sys.platform!='win32':raise SystemExit('Build the Windows desktop package on Windows')
    firmware=ROOT.parent/'aster-firmware';output=ROOT/'build/desktop-package';output.mkdir(parents=True,exist_ok=True)
    import imageio_ffmpeg
    ffmpeg=ROOT/'.tools/desktop/ffmpeg.exe';shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(),ffmpeg)
    command=[sys.executable,'-m','PyInstaller','--noconfirm','--clean','--onedir','--windowed','--name','aster-sim','--distpath',str(output/'dist'),'--workpath',str(output/'work'),'--specpath',str(output)]
    for source,destination in [(ROOT/'src','src'),(ROOT/'node_modules','node_modules'),(ROOT/'.tools/desktop/node.exe','.tools/desktop'),(ROOT/'build/desktop-windows/aster-desktop-core.exe','build/desktop-windows'),(firmware/'resources/fonts','resources/firmware/resources/fonts'),(firmware/'config','resources/firmware/config')]:
        command+=['--add-data',str(source)+';'+destination]
    command+=['--add-data',str(ffmpeg)+';.tools/desktop']
    subprocess.run(command+[str(ROOT/'desktop/main.py')],check=True)
    directory=output/'dist/aster-sim'
    for folder in ('src','node_modules'):
        root=directory/'_internal'/folder
        if folder=='src':
            for name in ('cli.js','server.js','web.js'): (root/name).unlink(missing_ok=True)
    identity={'schema':1,'version':'1.0.0','abi':'4.3.0','commit':subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip()}
    (directory/'release.json').write_text(json.dumps(identity,indent=2)+'\n')
    (directory/'README.txt').write_text('Aster desktop simulator. Launch aster-sim.exe. Debug: aster-sim.exe --profile p4 --app PATH_TO_PROJECT. External resources beside the AST package are detected automatically.\n',encoding='utf-8')
    dest=ROOT/'dist';dest.mkdir(exist_ok=True);archive=dest/'aster-sim-1.0.0-windows-x64.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for p in sorted(directory.rglob('*')):
            if p.is_file():z.write(p,p.relative_to(directory.parent))
    print(archive);print(hashlib.sha256(archive.read_bytes()).hexdigest())
if __name__=='__main__':main()
