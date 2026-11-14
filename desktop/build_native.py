"""Build the firmware UI desktop adapter with CMake (Windows via WSL/MinGW)."""
from pathlib import Path
import argparse
import shutil
import hashlib
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
def linux_path(path):
    p=Path(path).resolve().as_posix()
    return '/mnt/'+p[0].lower()+p[2:] if len(p)>2 and p[1]==':' else p

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wsl',default='Ubuntu-22.04')
    args=parser.parse_args()
    source=ROOT/'desktop/native'
    if sys.platform=='win32':
        build=ROOT/'build/desktop-windows'
        run=lambda command:subprocess.run(['wsl','-d',args.wsl,'--',*command],check=True)
        run(['cmake','-S',linux_path(source),'-B',linux_path(build),'-DCMAKE_SYSTEM_NAME=Windows','-DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc','-DCMAKE_EXE_LINKER_FLAGS=-static','-DCMAKE_BUILD_TYPE=Release'])
        run(['cmake','--build',linux_path(build),'-j','8'])
        node=shutil.which('node')
        if node:
            destination=ROOT/'.tools/desktop/node.exe'
            destination.parent.mkdir(parents=True,exist_ok=True)
            if Path(node).resolve()!=destination.resolve() and (not destination.exists() or hashlib.sha256(Path(node).read_bytes()).digest()!=hashlib.sha256(destination.read_bytes()).digest()):shutil.copy2(node,destination)
    else:
        build=ROOT/'build/desktop-core'
        subprocess.run(['cmake','-S',str(source),'-B',str(build),'-DCMAKE_BUILD_TYPE=Release'],check=True)
        subprocess.run(['cmake','--build',str(build),'-j','8'],check=True)

if __name__=='__main__':main()
