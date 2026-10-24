import subprocess, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
P='/tmp/claude-0/pw/'; W='/tmp/claude-0/promo/'; OUT='/home/user/Operation-structure-Project/cloud-erp/marketing/'
B='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; R='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
F=lambda p,s: ImageFont.truetype(p,s)
SCENES=[
 (None,'Dukaan ka poora hisaab','ek app me','नमस्ते! पेश है स्मार्टट्रेडर ई आर पी. दुकान का पूरा हिसाब, अब एक ही ऐप में.'),
 ('m-inv.png','GST bill 10 second me','UPI QR ke saath','जी एस टी बिल बनाइए सिर्फ़ दस सेकंड में. हर बिल पर यू पी आई क्यू आर छपता है.'),
 ('m-send.png','WhatsApp par bhejo','bill aur khata, ek tap me','बिल और खाते की हर एंट्री, सीधे व्हाट्सऐप या एस एम एस पर भेजिए.'),
 ('pay-upi.png','Customer khud confirm kare','aur UPI se turant pay','ग्राहक अपना खाता खुद देखकर कन्फ़र्म करता है, और यू पी आई से तुरंत पेमेंट करता है. भरोसा भी, जल्दी वसूली भी.'),
 ('pos.png','Barcode se tez billing','stock apne aap update','बारकोड स्कैन कीजिए, बिल बनाइए. स्टॉक अपने आप अपडेट होता है.'),
 ('dash.png','Munafa, GST, Balance Sheet','sab apne aap','मुनाफ़ा, जी एस टी और बैलेंस शीट, सब रिपोर्ट अपने आप तैयार.'),
 (None,'Free me shuru karein','erp.docbrisk.com','आज ही फ़्री में शुरू कीजिए. ई आर पी डॉट डॉक ब्रिस्क डॉट कॉम.'),
]
def bg(w,h):
    im=Image.new('RGB',(w,h)); d=ImageDraw.Draw(im)
    for y in range(h): t=y/h; d.line([(0,y),(w,y)],fill=(int(15-t),int(118-91*t),int(110-72*t)))
    return im
def logo(d,x,y,s):
    d.rounded_rectangle([x,y,x+s,y+s],radius=int(s*.22),fill='white')
    k=s/80; pts=[(x+14*k,y+62*k),(x+34*k,y+38*k),(x+48*k,y+50*k),(x+68*k,y+20*k)]
    d.line(pts,fill=(15,118,110),width=int(9*k),joint='curve')
def wrap(d,text,font,maxw):
    words=text.split(); lines=['']
    for w in words:
        t=(lines[-1]+' '+w).strip()
        if d.textlength(t,font=font)<=maxw: lines[-1]=t
        else: lines.append(w)
    return lines
def frame(scene,w,h,path):
    shot,title,sub,_=scene; im=bg(w,h); d=ImageDraw.Draw(im)
    vertical=h>w; s=w/1080 if vertical else h/1080
    logo(d,int(60*s),int(60*s),int(90*s)); d.text((int(170*s),int(78*s)),'SmartTrader ERP',font=F(B,int(52*s)),fill='white')
    if shot:
        img=Image.open(P+shot).convert('RGB')
        if vertical: boxw,boxh,ox,oy=int(w*.78),int(h*.56),None,int(h*.36)
        else: boxw,boxh,ox,oy=int(w*.5),int(h*.78),int(w*.46),None
        r=min(boxw/img.width,boxh/img.height); img=img.resize((int(img.width*r),int(img.height*r)),Image.LANCZOS)
        x=(w-img.width)//2 if ox is None else ox; y=oy if oy is not None else (h-img.height)//2
        sh=Image.new('RGBA',(img.width+40,img.height+40),(0,0,0,0)); ImageDraw.Draw(sh).rounded_rectangle([20,20,img.width+20,img.height+20],radius=30,fill=(0,0,0,120))
        im.paste(sh.filter(ImageFilter.GaussianBlur(14)),(x-20,y-6),sh.filter(ImageFilter.GaussianBlur(14)))
        mask=Image.new('L',img.size,0); ImageDraw.Draw(mask).rounded_rectangle([0,0,img.width,img.height],radius=int(24*s),fill=255)
        im.paste(img,(x,y),mask)
        tx,ty,tw=(int(70*s),int(250*s),w-int(140*s)) if vertical else (int(70*s),int(330*s),int(w*.4))
    else:
        tx,ty,tw=(int(70*s),int(h*.38),w-int(140*s)) if vertical else (int(110*s),int(h*.36),int(w*.8))
    tf=F(B,int((96 if not shot else 76)*s)); sf=F(R,int(48*s))
    for i,l in enumerate(wrap(d,title,tf,tw)): d.text((tx,ty+i*int(tf.size*1.15)),l,font=tf,fill='white')
    ty2=ty+len(wrap(d,title,tf,tw))*int(tf.size*1.15)+int(14*s)
    d.text((tx,ty2),sub,font=sf,fill=(190,240,232))
    if not shot and 'docbrisk' in sub:
        d.rounded_rectangle([tx,ty2+int(110*s),tx+int(560*s),ty2+int(210*s)],radius=int(50*s),fill='white')
        d.text((tx+int(40*s),ty2+int(132*s)),'Start free  →',font=F(B,int(52*s)),fill=(15,118,110))
    d.text((int(70*s),h-int(90*s)),'GST billing · Khata · Stock · Accounts',font=F(R,int(34*s)),fill=(170,215,208))
    im.save(path)
def build(name,w,h):
    parts=[]
    for i,sc in enumerate(SCENES):
        png=f'{W}{name}{i}.png'; wav=f'{W}a{i}.wav'; mp4=f'{W}{name}{i}.mp4'
        frame(sc,w,h,png)
        if not os.path.exists(wav): subprocess.run(['espeak-ng','-v','hi+f3','-s','140','-w',wav,sc[3]],check=True)
        subprocess.run(['ffmpeg','-y','-loglevel','error','-loop','1','-i',png,'-i',wav,'-af','apad=pad_dur=0.6','-shortest',
            '-vf',f"scale={w}:{h},zoompan=z='min(zoom+0.0006,1.05)':d=1:s={w}x{h}:fps=30,format=yuv420p",'-c:v','libx264','-preset','veryfast','-r','30','-c:a','aac','-b:a','128k',mp4],check=True)
        parts.append(mp4)
    open(W+name+'.txt','w').write(''.join(f"file '{p}'\n" for p in parts))
    subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',W+name+'.txt','-c','copy',OUT+name+'.mp4'],check=True)
build('SmartTrader-promo-reel-9x16',1080,1920)
build('SmartTrader-promo-16x9',1920,1080)
print('done')
