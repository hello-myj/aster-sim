"""Real native LVGL scroll-vs-slider regression through touch dispatch."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from test_window import APP,Window,ROOT,ARTIFACTS,until,pump

class MixerGestures(unittest.TestCase):
 def test_vertical_swipe_on_slider_scrolls_without_changing_settings(self):
  with tempfile.TemporaryDirectory(prefix='mixer-axis-',dir=ROOT/'build') as folder:
   kv=Path(folder)/'osptek-p4/shared/sd/aster/system/kv'
   kv.mkdir(parents=True)
   state=kv/'aster.launcher.flux.state'
   state.write_bytes(bytes([0,0,0,0,0,80,1,0]))
   volume=kv/'aster.qpanel.volume';volume.write_bytes(bytes([60]))
   args=SimpleNamespace(profile='osptek-p4',width=None,height=None,state=folder,wsl='Ubuntu-22.04',smoke=True,seed_local=True,title='Mixer gestures')
   window=Window(args)
   def stroke(points):
    window.touch(1,*points[0],0);pump(.09)
    for x,y in points[1:]:window.touch(2,x,y,0);pump(.09)
    window.touch(3,*points[-1],0);pump(.35)
   def open_mixer():
    stroke([(150,4),(150,45),(150,90),(150,150)])
    pump(.4)
   def reset_mixer():
    stroke([(50,20),(50,20)])
    open_mixer()
   try:
    until(lambda:window.dependencies_ready() and window.screen.image.width()==480)
    pump(.8);open_mixer()
    before=window.screen.image.copy(0,50,480,430)
    ARTIFACTS.mkdir(parents=True,exist_ok=True)
    window.save_screenshot(ARTIFACTS/'mixer-axis-before.png')
    stroke([(300,267),(312,240),(315,210),(315,180)])
    pump(1)
    window.save_screenshot(ARTIFACTS/'mixer-axis-after-vertical.png')
    self.assertEqual(state.read_bytes()[5],80)
    self.assertEqual(volume.read_bytes(),bytes([60]))
    self.assertNotEqual(before,window.screen.image.copy(0,50,480,430),'vertical swipe must scroll the actual settings page')
    reset_mixer()
    stroke([(300,392),(312,365),(315,335),(315,305)])
    pump(1)
    self.assertEqual(volume.read_bytes(),bytes([60]))
    self.assertEqual(state.read_bytes()[5],80)
    reset_mixer()
    # A first sideways jitter sample must not seize a later vertical stroke.
    stroke([(300,267),(320,270),(321,240),(322,205)])
    pump(1)
    self.assertEqual(state.read_bytes()[5],80)
    self.assertEqual(volume.read_bytes(),bytes([60]))
    reset_mixer()
    # Multiple raw samples in one UI frame must preserve the real press origin.
    window.touch(1,300,267,0)
    window.touch(2,320,270,0)
    window.touch(2,321,240,0)
    window.touch(2,322,205,0)
    window.touch(3,322,205,0)
    pump(1)
    self.assertEqual(state.read_bytes()[5],80)
    self.assertEqual(volume.read_bytes(),bytes([60]))
    reset_mixer()
    stroke([(320,267),(280,268),(230,268)])
    pump(1)
    self.assertNotEqual(state.read_bytes()[5],80,'horizontal brightness drag must still work')
    self.assertEqual(volume.read_bytes(),bytes([60]))
    reset_mixer()
    stroke([(270,392),(235,393),(200,393)])
    pump(1)
    self.assertNotEqual(volume.read_bytes(),bytes([60]),'horizontal volume drag must still work')
   finally:window.close();APP.processEvents()
