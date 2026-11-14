/* Reuse the firmware's pitch/ramp/loop/crossfade mixer on desktop. */
#include "desktop.h"
#include "audio_effect_engine.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
static struct {uint32_t handle;void *data;audio_effect_voice_t voice;} slots[4];
static audio_effect_voice_t ui;
static bool paused;
static unsigned volume=70;
static uint32_t ui_priority;
static int16_t output[4800*2];
static int find(uint32_t handle){for(int i=0;i<4;i++)if(slots[i].handle==handle)return i;return -1;}
int desktop_audio_ui(const int16_t *pcm,size_t frames,unsigned gain,unsigned priority){
 if(!pcm||!frames||gain>1000)return -EINVAL;
 if(ui.playing&&priority<ui_priority)return -EAGAIN;
 ui=(audio_effect_voice_t){.pcm=pcm,.size=frames*2,.frames=frames,.rate=16000,.channels=1};ui_priority=priority;
 aster_audio_effect_play_desc_t desc={.size=sizeof(desc),.version=1,.pitch_q16=65536,.gain_q16=gain*65536/1000};return audio_effect_begin(&ui,&desc);
}
void desktop_audio_stop_ui(void){ui.playing=false;}
void desktop_audio_command(const char *line){
 unsigned handle,a,b,c,d,e,f,g;char op=line[0];
 if(op=='L'){
  unsigned rate,channels,size;if(sscanf(line+1,"%u%u%u%u",&handle,&rate,&channels,&size)!=4||!handle||size>65536||!size||(channels!=1&&channels!=2)||rate<8000||rate>48000||size%(channels*2))exit(3);
  void *data=malloc(size);if(!data)exit(4);if(fread(data,1,size,stdin)!=size)exit(3);
  int i=find(handle);if(i<0)for(int j=0;j<4;j++)if(!slots[j].handle){i=j;break;}
  if(i<0){free(data);return;}free(slots[i].data);memset(&slots[i],0,sizeof(slots[i]));slots[i].handle=handle;slots[i].data=data;
  slots[i].voice=(audio_effect_voice_t){.pcm=data,.size=size,.frames=size/channels/2,.rate=rate,.channels=channels};return;
 }
 if(op=='Z'){for(int i=0;i<4;i++){free(slots[i].data);memset(&slots[i],0,sizeof(slots[i]));}paused=false;return;}
 if(op=='Y'){paused=atoi(line+1)!=0;return;}
 if(op=='W'){volume=(unsigned)atoi(line+1);if(volume>100)volume=100;return;}
 if(sscanf(line+1,"%u",&handle)!=1)return;int i=find(handle);if(i<0)return;
 if(op=='X'){free(slots[i].data);memset(&slots[i],0,sizeof(slots[i]));}
 else if(op=='E'&&sscanf(line+1,"%u%u%u%u%u%u%u%u",&handle,&a,&b,&c,&d,&e,&f,&g)==8){
  aster_audio_effect_play_desc_t desc={.size=sizeof(desc),.version=1,.flags=a,.loop_start_frame=b,.loop_end_frame=c,.crossfade_frames=d,.pitch_q16=e,.gain_q16=f,.fade_in_ms=g};(void)audio_effect_begin(&slots[i].voice,&desc);
 }else if(op=='U'&&sscanf(line+1,"%u%u%u%u",&handle,&a,&b,&c)==4){aster_audio_effect_params_t params={.size=sizeof(params),.version=1,.pitch_q16=a,.gain_q16=b,.ramp_ms=c};(void)audio_effect_params(&slots[i].voice,&params);}
 else if(op=='V'&&sscanf(line+1,"%u%u",&handle,&a)==2)(void)audio_effect_stop(&slots[i].voice,a);
}
void desktop_audio_tick(unsigned dt){
 bool active=ui.playing;for(int i=0;i<4;i++)active|=!paused&&slots[i].voice.playing;if(!active)return;
 unsigned count=dt*48;if(count>4800)count=4800;
 for(unsigned sample=0;sample<count;sample++){
  int32_t l=0,r=0;if(ui.playing)audio_effect_sample(&ui,48000,&l,&r);
  if(!paused)for(int i=0;i<4;i++)audio_effect_sample(&slots[i].voice,48000,&l,&r);
  l=l*(int)volume/100;r=r*(int)volume/100;output[sample*2]=l< -32768?-32768:l>32767?32767:l;output[sample*2+1]=r< -32768?-32768:r>32767?32767:r;
 }
 uint32_t header[]={0x4d495341,3,count*4};fwrite(header,1,sizeof(header),stdout);fwrite(output,4,count,stdout);fflush(stdout);
}
