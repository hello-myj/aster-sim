"""Sparse PCM tracks on the same monotonic clock as desktop video."""
from array import array
from pathlib import Path
import sys
import time

RATE=48000
FRAME_BYTES=4  # S16LE, stereo

class AudioTracks:
    def __init__(self,directory,started):
        self.started=started
        self.paths={name:Path(directory)/(name+'.s16le') for name in ('effects','music')}
        self.files={name:path.open('w+b') for name,path in self.paths.items()}
        self.ends={name:0 for name in self.paths}
        self.continuous={name:False for name in self.paths}

    def reset(self,source):self.continuous[source]=False

    def add(self,source,data,*,at=None,gain=1.0):
        if not data:return
        if len(data)%FRAME_BYTES:raise ValueError('Recording expects stereo S16LE PCM')
        position=round(((time.monotonic() if at is None else at)-self.started)*RATE)
        if position<0:
            data=data[min(len(data),-position*FRAME_BYTES):];position=0
        if not data:return
        # Audio buffers arrive in bursts. Keep adjacent samples contiguous while
        # preserving real pauses as silence; reset on music seek/start/resume.
        end=self.ends[source]
        if self.continuous[source] and abs(position-end)<=RATE//10:position=end
        elif position<end:
            data=data[min(len(data),(end-position)*FRAME_BYTES):];position=end
        if not data:return
        if gain!=1:
            samples=array('h');samples.frombytes(data)
            if sys.byteorder!='little':samples.byteswap()
            samples=array('h',(max(-32768,min(32767,round(v*gain))) for v in samples))
            if sys.byteorder!='little':samples.byteswap()
            data=samples.tobytes()
        file=self.files[source];file.seek(position*FRAME_BYTES);file.write(data)
        self.ends[source]=position+len(data)//FRAME_BYTES;self.continuous[source]=True

    def close(self,frames):
        # Extending a sparse file supplies silence, so even a silent clip has an
        # audio track with exactly the same duration as the encoded video.
        for file in self.files.values():
            file.truncate(frames*FRAME_BYTES);file.close()
        self.files.clear()

    def abort(self):
        for file in self.files.values():file.close()
        self.files.clear()
