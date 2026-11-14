from array import array
from pathlib import Path
import tempfile
import unittest
from recording import AudioTracks,RATE

class AudioTrackTests(unittest.TestCase):
    def test_gaps_gain_continuity_and_exact_video_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            tracks=AudioTracks(directory,100)
            data=array('h',[1000,-1000]*480).tobytes()
            tracks.add('music',data,at=100.02,gain=.5)
            tracks.add('music',data,at=100.025,gain=.5) # delivery jitter, contiguous PCM
            tracks.reset('music')
            tracks.add('music',data,at=100.1,gain=0)
            tracks.add('effects',data,at=99.995) # crop the part before recording starts
            tracks.close(9600)
            music=array('h');music.frombytes(tracks.paths['music'].read_bytes())
            effects=array('h');effects.frombytes(tracks.paths['effects'].read_bytes())
            self.assertEqual(len(music),19200)
            self.assertEqual(music[:1920],array('h',[0]*1920))
            self.assertEqual(music[1920:3840],array('h',[500,-500]*960))
            self.assertTrue(all(x==0 for x in music[3840:]))
            self.assertEqual(effects[:480],array('h',[1000,-1000]*240))
            self.assertTrue(all(x==0 for x in effects[480:]))

if __name__=='__main__':unittest.main()
