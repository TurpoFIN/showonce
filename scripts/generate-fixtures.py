#!/usr/bin/env python3
"""Reproducible authored, synthetic traffic footage. Not real camera or model output.
Requires Python 3, Pillow, and ffmpeg. python scripts/generate-fixtures.py
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import math, random, subprocess, json
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public'/'clips';OUT.mkdir(parents=True,exist_ok=True)
W,H,FPS,DURATION=960,540,12,12
FONT='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
MONO='/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
font=lambda s: ImageFont.truetype(FONT,s)
mono=lambda s: ImageFont.truetype(MONO,s)
CASES=[
 ('train-positive-01','Travel lane · stopped vehicle','stop',9,True),
 ('train-negative-01','Shoulder · safely stopped','shoulder',9,False),
 ('train-negative-02','Travel lane · slow traffic','crawl',9,False),
 ('holdout-01','Stopped in center lane','stop',9,True),
 ('holdout-02','Stopped on shoulder','shoulder',9,False),
 ('holdout-03','Crawling with traffic','crawl',9,False),
 ('holdout-04','Stopped in right lane','stop_right',8.5,True),
 ('holdout-05','Brief pause, then moving','brief',3,False),
 ('holdout-06','Moving through the lane','moving',0,False),
 ('replay-01','Replay · stopped vehicle','stop',9,True),
]
def rx(base,y):return base+.48*(H-y)
def point(base,y):return (rx(base,y),y)
def scenery(seed):
 random.seed(seed);im=Image.new('RGB',(W,H),'#788774');d=ImageDraw.Draw(im)
 # Landscape parcels and planted drainage strips.
 d.polygon([(0,0),(310,0),(60,540),(0,540)],fill='#91a184')
 d.polygon([(840,0),(960,0),(960,540),(610,540)],fill='#9d9b7c')
 for i in range(85):
  x=random.randrange(W);y=random.randrange(H);base=x-.48*(H-y)
  if 95<base<645:continue
  r=random.randrange(7,34);d.ellipse((x-r,y-r,x+r,y+r),fill=random.choice(['#667d62','#728862','#839475','#768767','#718469']))
  d.arc((x-r+2,y-r,x+r,y+r),180,330,fill='#9ba98b',width=2)
 for b,col,width in [(70,'#bac0a0',8),(650,'#c6bea0',8),(90,'#5b675c',3),(630,'#62695c',3)]:d.line([point(b,0),point(b,H)],fill=col,width=width)
 # Three travel lanes and shoulder, concrete border, central roadside shadow.
 d.polygon([point(115,0),point(600,0),point(600,H),point(115,H)],fill='#596562')
 d.polygon([point(132,0),point(575,0),point(575,H),point(132,H)],fill='#485655')
 d.polygon([point(525,0),point(575,0),point(575,H),point(525,H)],fill='#53605b')
 for b,col in [(141,'#d4d4b5'),(510,'#d4d8c4'),(565,'#b7c1ab')]:d.line([point(b,0),point(b,H)],fill=col,width=3)
 for b in [264,387]:
  for y in range(-15,H,75):d.line([point(b,y),point(b,y+33)],fill='#d2d8c5',width=3)
 # Muted noise adds depth without pretending to be real footage.
 for i in range(750):
  y=random.randrange(H);b=random.uniform(145,565);x=rx(b,y);d.point((x,y),fill=random.choice(['#4d5a57','#52605b','#42524f']))
 for y in range(20,H,70):
  x=rx(607,y);d.line((x-2,y,x+7,y+4),fill='#e0dcc0',width=3)
 return im
BASE=scenery(28)
def car(image,base,y,color,length=48,focus=False):
 x=rx(base,y);layer=Image.new('RGBA',(72,92));d=ImageDraw.Draw(layer)
 d.rounded_rectangle((23,23,51,81),radius=8,fill='#1c302a72')
 d.rounded_rectangle((18,16,45,72),radius=7,fill=color,outline='#b3c1b06b',width=1)
 d.rounded_rectangle((21,29,42,56),radius=4,fill='#294a4d')
 d.rectangle((21,38,42,45),fill=color)
 d.line((20,23,43,23),fill='#d9e2c5',width=2)
 d.line((21,64,27,64),fill='#eec58b',width=2);d.line((36,64,42,64),fill='#eec58b',width=2)
 layer=layer.rotate(-25.65,resample=Image.Resampling.BICUBIC,expand=True)
 image.paste(layer,(round(x-layer.width/2),round(y-layer.height/2)),layer)
 return x,y

def primary_y(kind,t,duration):
 if kind in ['stop','stop_right','shoulder']:
  start=12-duration;return 454-(454-285)*min(t/start,1), 5.2 if t<start else 0
 if kind=='brief':
  if t<4:return 454-40*t,4
  if t<7:return 294,0
  return 294-43*(t-7),4.3
 if kind=='crawl':return 435-13*t,1.3
 return 505-35*t,4

def frame(case,t):
 cid,title,kind,duration,label=case;im=BASE.copy();d=ImageDraw.Draw(im)
 # Other traffic remains separate from the target track.
 offset=sum(ord(c) for c in cid)%90
 for idx,(lane,start,speed,col) in enumerate([(203,100,32,'#bbc6b5'),(448,410,27,'#8dabb4'),(203,500,26,'#c1b99d'),(448,30,33,'#aeb3a2')]):
  y=((start+offset-speed*t+160)%840)-150
  car(im,lane,y,col)
 y,speed=primary_y(kind,t,duration);base=542 if kind=='shoulder' else 448 if kind=='stop_right' else 326
 x,y=car(im,base,y,'#dcc994',focus=True)
 d=ImageDraw.Draw(im)
 # Track overlay is visual ground truth authored by the fixture generator.
 l,top,r,b=x-35,y-42,x+35,y+38
 for a in [(l,top,l+12,top),(l,top,l,top+12),(r-12,top,r,top),(r,top,r,top+12),(l,b,l+12,b),(l,b-12,l,b),(r-12,b,r,b),(r,b-12,r,b)]:d.line(a,fill='#dcf28e',width=2)
 txt=f'TRACK 04  {speed:.1f} m/s';tw=d.textlength(txt,font=mono(10));d.rounded_rectangle((l-1,top-22,l+tw+13,top-4),radius=3,fill='#223d35');d.text((l+5,top-20),txt,font=mono(10),fill='#e0efb0')
 # Camera furniture is intentionally marked synthetic, never a fabricated live feed.
 d.rounded_rectangle((20,19,235,49),radius=5,fill='#213b33d0');d.ellipse((31,30,37,36),fill='#dcf38e');d.text((47,26),'SYNTHETIC  /  CAMERA 04',font=mono(10),fill='#e1ebd7')
 d.rounded_rectangle((W-185,19,W-19,48),radius=5,fill='#213b33');d.text((W-174,27),f'09:41:{int(t):02d}.{int(t%1*100):02d}  +0000',font=mono(10),fill='#d7e3cd')
 d.text((22,H-32),'NORTHBOUND CORRIDOR  /  AUTHORED SCENARIO',font=mono(10),fill='#eff0d9',stroke_width=1,stroke_fill='#4c6455')
 # subtle inset perimeter
 d.rounded_rectangle((9,9,W-10,H-10),radius=5,outline='#d3e6b332',width=1)
 return im
manifest=[]
for case in CASES:
 cid,title,kind,duration,label=case;path=OUT/f'{cid}.mp4'
 cmd=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','25','-pix_fmt','yuv420p','-movflags','+faststart',str(path)]
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE)
 for i in range(FPS*DURATION):p.stdin.write(frame(case,i/FPS).tobytes())
 p.stdin.close();ret=p.wait()
 if ret:raise RuntimeError(f'ffmpeg failed {cid}')
 frame(case,6).save(OUT/f'{cid}.jpg',quality=88)
 manifest.append({'id':cid,'title':title,'durationSec':DURATION,'source':'authored_synthetic_fixture','scenario':kind,'eventPresent':label,'stationaryDurationSec':duration if kind!='crawl' else 0,'videoUrl':f'/clips/{cid}.mp4','posterUrl':f'/clips/{cid}.jpg'})
 print(cid, path.stat().st_size,flush=True)
(OUT/'manifest.json').write_text(json.dumps({'warning':'Synthetic authored video fixtures. Labels and track overlays are authored ground truth, not provider predictions. Fixture agreement is not real-world accuracy.','clips':manifest},indent=2)+'\n')
