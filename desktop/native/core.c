#include "desktop.h"
#include "launcher.h"
#include "ui_lvgl.h"
#include <lvgl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif
void desktop_event(const char *kind,const char *value){
 char body[512];int n=snprintf(body,sizeof(body),"%s\t%s",kind,value);if(n<0||n>=(int)sizeof(body))return;
 uint32_t header[]={0x4d495341,2,(uint32_t)n};fwrite(header,1,sizeof(header),stdout);fwrite(body,1,n,stdout);fflush(stdout);
}
int main(int argc,char **argv){
 if(argc!=4)return 2;unsigned w=atoi(argv[1]),h=atoi(argv[2]);if(w<240||w>2048||h<240||h>2048)return 2;
#ifdef _WIN32
 _setmode(_fileno(stdout),_O_BINARY);
 _setmode(_fileno(stdin),_O_BINARY);
#endif
 desktop_init(w,h,argv[3]);char line[4096];
 while(fgets(line,sizeof(line),stdin)){
  line[strcspn(line,"\r\n")]=0;
  if(line[0]=='T'){unsigned dt=16;if(sscanf(line+1,"%u",&dt)!=1||dt>100)continue;desktop_ms+=dt;lv_tick_inc(dt);desktop_frame();desktop_audio_tick(dt);uint32_t ack[]={0x4d495341,4,0};fwrite(ack,1,sizeof(ack),stdout);fflush(stdout);}
  else if(line[0]=='P'){int a,x,y,s;if(sscanf(line+1,"%d%d%d%d",&a,&x,&y,&s)==4&&a>=1&&a<=3&&x>=0&&x<(int)w&&y>=0&&y<(int)h&&s>=0&&s<5)desktop_touch(a,x,y,s);}
  else if(line[0]=='C')desktop_catalog_clear();
  else if(line[0]=='A'){
   char *fields[5],*p=line+2;int valid=1;for(int i=0;i<5;i++){fields[i]=p;char *tab=strchr(p,'\t');if(i<4&&!tab){valid=0;break;}if(tab){*tab=0;p=tab+1;}}
   if(valid)desktop_catalog_add(fields[0],fields[1],fields[2],fields[3],fields[4]);
  }else if(line[0]=='R')desktop_home();
  else if(line[0]=='H')desktop_app();
  else if(line[0]=='B'){
   unsigned size=0;if(sscanf(line+1,"%u",&size)!=1||size!=(size_t)w*h*2)return 3;
   uint8_t *data=malloc(size);if(!data)return 4;
   if(fread(data,1,size,stdin)!=size){free(data);return 3;}desktop_app_pixels(data,size);free(data);
  }
  else if(strchr("LEUVXYZW",line[0]))desktop_audio_command(line);
  else if(strchr("ISK",line[0]))desktop_setup_command(line);
  else if(line[0]=='N'){int d=atoi(line+1);aster_launcher_step_page(d);}
  else if(line[0]=='Q')break;
 }
 return 0;
}
