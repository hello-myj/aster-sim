/* Desktop adapters for the same public ports used by IDF and Zephyr. */
#include "desktop.h"
#include "aster_device.h"
#include "aster_os.h"
#include "aster_services.h"
#include "aster_port_util.h"
#include "ui_lvgl.h"
#include "launcher.h"
#include "font_sd.h"
#include "qpanel.h"
#include "wifi_settings.h"
#include "gesture.h"
#include "setup_ui.h"
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/stat.h>
#include <dirent.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif
unsigned desktop_width,desktop_height;
uint64_t desktop_ms;
uint16_t *desktop_pixels;
static char sd_root[4096];
static lv_display_t *display;
static lv_indev_t *pointer;
static int pointer_x,pointer_y,pointer_down,volume=70;
static bool changed=true,app_active,overlay;
static uint32_t contact_mask;
static aster_touch_evt_t touches[32];static unsigned touch_n;
static aster_service_app_t records[64];static unsigned record_n;
static void (*registry_cb)(void);
static uint16_t *glass,*wire;
static void *alloc(size_t n,unsigned region){(void)region;return malloc(n);}
static void release(void *p,unsigned region){(void)region;free(p);}
/* LVGL pool allocator hook is part of its build configuration. */
void *aster_psram_alloc(size_t n){return malloc(n);}
void aster_psram_free(void *p){free(p);}
void aster_ui_lvgl_assert(void){fputs("LVGL assertion failed\n",stderr);abort();}
static const char *mapped(const char *path,char *out,size_t n){
 if(strncmp(path,"/SD:",4)||strstr(path,"..")||strchr(path,'\\'))return NULL;
 if(snprintf(out,n,"%s%s",sd_root,path+4)>=(int)n)return NULL;
 return out;
}
static int file_open(aster_os_file_t *f,const char *path,unsigned flags){
 char p[4096];if(!f||f->handle||!mapped(path,p,sizeof(p))||!flags||(flags&~31u))return -EINVAL;
 const char *mode=flags&ASTER_OS_APPEND?"a+b":flags&ASTER_OS_TRUNCATE?"w+b":flags&ASTER_OS_WRITE?"r+b":"rb";
 FILE *fp=fopen(p,mode);if(!fp&&(flags&ASTER_OS_CREATE))fp=fopen(p,"w+b");
 if(!fp)return -errno;f->handle=fp;return 0;
}
static int file_close(aster_os_file_t *f){if(!f||!f->handle)return -EBADF;int r=fclose(f->handle);f->handle=NULL;return r?-EIO:0;}
static int file_read(aster_os_file_t *f,void *data,size_t n){if(!f||!f->handle)return -EBADF;size_t r=fread(data,1,n,f->handle);return ferror(f->handle)?-EIO:(int)r;}
static int file_write(aster_os_file_t *f,const void *data,size_t n){if(!f||!f->handle)return -EBADF;size_t r=fwrite(data,1,n,f->handle);return ferror(f->handle)?-EIO:(int)r;}
static int file_seek(aster_os_file_t *f,int64_t offset,unsigned whence){
 if(!f||!f->handle||whence>2)return -EINVAL;
#ifdef _WIN32
 return _fseeki64(f->handle,offset,whence)?-EIO:0;
#else
 return fseeko(f->handle,(off_t)offset,whence)?-EIO:0;
#endif
}
static int file_sync(aster_os_file_t *f){return f&&f->handle?(fflush(f->handle)?-EIO:0):-EBADF;}
static int stat_path(const char *p,aster_os_entry_t *out){
 char path[4096];struct stat s;if(!out||!mapped(p,path,sizeof(path)))return -EINVAL;memset(out,0,sizeof(*out));
 if(stat(path,&s))return -errno;out->size=s.st_size;out->type=S_ISDIR(s.st_mode)?ASTER_OS_DIRECTORY:ASTER_OS_FILE;return 0;
}
struct directory {DIR *dir;char path[4096];};
static int dir_open(aster_os_dir_t *d,const char *path){
 if(!d||d->handle)return -EINVAL;struct directory *r=calloc(1,sizeof(*r));if(!r)return -ENOMEM;
 if(!mapped(path,r->path,sizeof(r->path))){free(r);return -EINVAL;}r->dir=opendir(r->path);if(!r->dir){free(r);return -errno;}d->handle=r;return 0;
}
static int dir_read(aster_os_dir_t *d,aster_os_entry_t *out){
 if(!d||!d->handle||!out)return -EINVAL;struct directory *r=d->handle;struct dirent *v;memset(out,0,sizeof(*out));
 do{v=readdir(r->dir);}while(v&&(!strcmp(v->d_name,".")||!strcmp(v->d_name,"..")));
 if(!v)return 0;snprintf(out->name,sizeof(out->name),"%s",v->d_name);
 char p[4352];struct stat s;snprintf(p,sizeof(p),"%s/%s",r->path,v->d_name);if(!stat(p,&s)){out->size=s.st_size;out->type=S_ISDIR(s.st_mode)?ASTER_OS_DIRECTORY:ASTER_OS_FILE;}return 0;
}
static int dir_close(aster_os_dir_t *d){if(!d||!d->handle)return -EBADF;struct directory *r=d->handle;int error=closedir(r->dir);free(r);d->handle=NULL;return error?-EIO:0;}
static uint64_t uptime(void){return desktop_ms;}
static uint32_t cycles(void){return (uint32_t)((uint64_t)clock()*1000000/CLOCKS_PER_SEC);}
static void sleep_ms(uint32_t ms){
#ifdef _WIN32
 Sleep(ms);
#else
 usleep(ms*1000);
#endif
}
static int wall_clock(aster_time_info_t *out){time_t v=time(NULL);struct tm *t=localtime(&v);memset(out,0,sizeof(*out));out->size=sizeof(*out);out->version=1;out->unix_ms=(uint64_t)v*1000;out->flags=1;out->year=t->tm_year+1900;out->month=t->tm_mon+1;out->day=t->tm_mday;out->hour=t->tm_hour;out->minute=t->tm_min;out->second=t->tm_sec;out->weekday=t->tm_wday;return 0;}
const aster_os_ops_t aster_os_backend={.size=sizeof(aster_os_ops_t),.version=ASTER_OS_API_VERSION,.name="desktop",
 .alloc=alloc,.free=release,.uptime_ms=uptime,.cycle_us=cycles,.sleep_ms=sleep_ms,.wall_clock=wall_clock,
 .file_open=file_open,.file_close=file_close,.file_read=file_read,.file_write=file_write,.file_seek=file_seek,.file_sync=file_sync,.stat=stat_path,.dir_open=dir_open,.dir_read=dir_read,.dir_close=dir_close};
static bool mounted(void){return true;}
static int code_dir(char *out,size_t n,const char *id){return snprintf(out,n,"/SD:/aster/apps/%s",id)>=(int)n?-EINVAL:0;}
static bool kv_path(char *out,size_t n,const char *id,const char *key){if(strchr(id,'/')||strchr(key,'/')||strstr(id,"..")||strstr(key,".."))return false;return snprintf(out,n,"%s/aster/system/kv/%s.%s",sd_root,id,key)<(int)n;}
static int kv_get(const char *id,const char *key,void *out,size_t n,size_t *size){
 char p[4352];if(!kv_path(p,sizeof(p),id,key))return -EINVAL;FILE *f=fopen(p,"rb");if(!f)return -ENOENT;size_t count=fread(out,1,n,f);int extra=fgetc(f);fclose(f);if(size)*size=count;return extra==EOF?0:-ENOSPC;
}
static int kv_set(const char *id,const char *key,const void *data,size_t n){char p[4352];if(!kv_path(p,sizeof(p),id,key))return -EINVAL;FILE *f=fopen(p,"wb");if(!f)return -errno;bool ok=fwrite(data,1,n,f)==n;int r=fclose(f);return ok&&!r?0:-EIO;}
void desktop_catalog_clear(void){record_n=0;}
void desktop_catalog_add(const char *id,const char *name,const char *desc,const char *version,const char *category){if(record_n>=64)return;aster_service_app_t *r=&records[record_n++];memset(r,0,sizeof(*r));snprintf(r->id,sizeof(r->id),"%s",id);snprintf(r->name,sizeof(r->name),"%s",name);snprintf(r->description,sizeof(r->description),"%s",desc);snprintf(r->version,sizeof(r->version),"%s",version);snprintf(r->category,sizeof(r->category),"%s",category);r->has_icon=true;}
static int app_count(void){return record_n;}
static bool app_snapshot(int i,aster_service_app_t *out){if(i<0||(unsigned)i>=record_n)return false;*out=records[i];return true;}
static bool app_find(const char *id,aster_service_app_t *out){for(unsigned i=0;i<record_n;i++)if(!strcmp(id,records[i].id)){*out=records[i];return true;}return false;}
static void registry_callback(void (*cb)(void)){registry_cb=cb;}
static void files_lock(void){}
static int uninstall(const char *id){desktop_event("uninstall",id);return 0;}
static int launch(const char *id){desktop_event("launch",id);return 0;}
static int system_info(aster_system_info_t *out){memset(out,0,sizeof(*out));out->size=sizeof(*out);out->version=1;out->abi_version=ASTER_ABI_VERSION;strcpy(out->platform,"desktop");strcpy(out->board,"aster.simulator");strcpy(out->soc,"host");out->cpu_arch=ASTER_ARCH_X86;out->cpu_count=1;return 0;}
static void log_message(unsigned level,const char *text){fprintf(stderr,"[%u] %s\n",level,text);}
const aster_services_ops_t aster_services_backend={.size=sizeof(aster_services_ops_t),.version=ASTER_SERVICES_API_VERSION,.name="desktop",
 .system_info=system_info,.app_count=app_count,.app_snapshot=app_snapshot,.app_find=app_find,.app_start=launch,.app_uninstall=uninstall,.registry_callback=registry_callback,.files_lock=files_lock,.files_unlock=files_lock,.storage_mounted=mounted,.app_code_dir=code_dir,.kv_get=kv_get,.kv_set=kv_set,.log=log_message};
static void read_pointer(lv_indev_t *i,lv_indev_data_t *d){(void)i;d->point.x=pointer_x;d->point.y=pointer_y;d->state=pointer_down?LV_INDEV_STATE_PRESSED:LV_INDEV_STATE_RELEASED;}
static void flush(lv_display_t *d,const lv_area_t *area,uint8_t *data){(void)area;(void)data;for(size_t i=0;i<(size_t)desktop_width*desktop_height;i++){uint16_t v=desktop_pixels[i];glass[i]=(v>>8)|(v<<8);}changed=true;lv_display_flush_ready(d);}
void desktop_init(unsigned w,unsigned h,const char *sd){desktop_width=w;desktop_height=h;snprintf(sd_root,sizeof(sd_root),"%s",sd);aster_device_seal();aster_os_seal();aster_services_seal();lv_init();display=lv_display_create(w,h);desktop_pixels=calloc((size_t)w*h,2);glass=calloc((size_t)w*h,2);wire=calloc((size_t)w*h,2);if(!desktop_pixels||!glass||!wire)abort();lv_display_set_color_format(display,LV_COLOR_FORMAT_RGB565);lv_display_set_buffers(display,desktop_pixels,NULL,w*h*2,LV_DISPLAY_RENDER_MODE_DIRECT);lv_display_set_flush_cb(display,flush);pointer=lv_indev_create();lv_indev_set_type(pointer,LV_INDEV_TYPE_POINTER);lv_indev_set_read_cb(pointer,read_pointer);aster_font_sd_init();aster_font_sd_poll();aster_launcher_request_show();}
void aster_ui_lvgl_pointer(uint32_t x,uint32_t y,int down){pointer_x=x;pointer_y=y;pointer_down=down;}
void aster_ui_lvgl_pump(void){lv_timer_handler();}
void aster_ui_lvgl_request_frame(void){lv_refr_now(display);}
void aster_ui_lvgl_resync_window(void){}
lv_obj_t *aster_ui_lvgl_screen(void){return lv_screen_active();}
uint32_t aster_ui_lvgl_width(void){return desktop_width;}
uint32_t aster_ui_lvgl_height(void){return desktop_height;}
uint32_t aster_ui_lvgl_layout_width(void){return desktop_width;}
uint32_t aster_ui_lvgl_layout_height(void){return desktop_height;}
lv_indev_t *aster_ui_lvgl_indev(void){return pointer;}
void desktop_touch(int action,int x,int y,int slot){if(action==3)contact_mask&=~(1u<<slot);else contact_mask|=1u<<slot;if(touch_n<ARRAY_SIZE(touches))touches[touch_n++]=(aster_touch_evt_t){x,y,action,slot,contact_mask};}
static int input_poll(aster_touch_evt_t *out,int max){int n=MIN((int)touch_n,max);memcpy(out,touches,n*sizeof(*out));memmove(touches,touches+n,(touch_n-n)*sizeof(*out));touch_n-=n;return n;}
static int keys_poll(aster_key_evt_t *out,int max){(void)out;(void)max;return 0;}
static int display_count(void){return 1;}
static int orientation_get(void){return 0;}
static int orientation_set(int v){(void)v;return 0;}
static int display_info(uint32_t i,aster_display_info_t *out){if(i||!out)return -EINVAL;*out=(aster_display_info_t){.size=sizeof(*out),.version=1,.width=desktop_width,.height=desktop_height};return 0;}
static void drain(void){}
static int write_at(const uint8_t *data,uint32_t x,uint32_t y,uint32_t w,uint32_t h,uint32_t pitch,bool swapped){if(x+w>desktop_width||y+h>desktop_height)return -EINVAL;for(unsigned row=0;row<h;row++)for(unsigned col=0;col<w;col++){uint16_t v;memcpy(&v,data+2*(row*pitch+col),2);glass[(y+row)*desktop_width+x+col]=swapped?v:(v>>8)|(v<<8);}changed=true;return 0;}
static int write_plain(const uint8_t *p,uint32_t x,uint32_t y,uint32_t w,uint32_t h,uint32_t pitch){return write_at(p,x,y,w,h,pitch,false);}
static bool glass_frame(const uint8_t **out,uint32_t *w,uint32_t *h,uint32_t *pitch){*out=(void *)glass;*w=desktop_width;*h=desktop_height;*pitch=desktop_width;return true;}
static int backlight(bool on,uint8_t value){(void)on;(void)value;return 0;}
static int get_volume(void){return volume;}
static int set_volume(int v){volume=v;char value[24],command[32];snprintf(value,sizeof(value),"%d",v);snprintf(command,sizeof(command),"W %d",v);desktop_audio_command(command);desktop_event("volume",value);return 0;}
static int ui_play(const int16_t *pcm,size_t n,unsigned gain,unsigned priority){return desktop_audio_ui(pcm,n,gain,priority);}
static void ui_stop(void){desktop_audio_stop_ui();}
static int wifi_status(aster_wifi_status_t *s){memset(s,0,sizeof(*s));strcpy(s->ssid,"Aster Desktop");strcpy(s->ip,"127.0.0.1");s->state=ASTER_PLAT_WIFI_STATE_COMPLETED;s->rssi=-40;s->security=1;return 0;}
static int last_ssid(char *out,size_t n){snprintf(out,n,"Aster Desktop");return 0;}
static uint32_t security(uint8_t v){return v;}
static int scan_start(void){return 0;}
static int scan_results(aster_wifi_ap_t *out,int max,int *count){*count=max>0?1:0;if(max>0){memset(out,0,sizeof(*out));strcpy(out->ssid,"Aster Desktop");out->rssi=-40;out->channel=6;out->security=0;}return 0;}
static int connect_start(const char *s,const char *p){(void)s;(void)p;return 0;}
static int disconnect_start(void){return 0;}
static void wifi_operation(uint32_t *op,uint32_t *last,int *r){*op=0;*last=0;*r=0;}
static int hotspot_start(const char *s,const char *p){(void)s;(void)p;return -ENOTSUP;}
static void hotspot_status(aster_wifi_hotspot_status_t *out){memset(out,0,sizeof(*out));}
const aster_device_ops_t aster_device_backend={.size=sizeof(aster_device_ops_t),.version=ASTER_DEVICE_API_VERSION,.name="desktop",
 .display_count=display_count,.display_get_info=display_info,.display_orientation_get=orientation_get,.display_orientation_set=orientation_set,.display_write_at=write_plain,.display_write_at_ex=write_at,.display_glass_frame=glass_frame,.display_flush_drain=drain,.backlight_set=backlight,.input_poll=input_poll,.input_keys_poll=keys_poll,
 .audio_get_volume=get_volume,.audio_set_volume=set_volume,.audio_ui_play=ui_play,.audio_ui_stop=ui_stop,.audio_ui_release=ui_stop,
 .wifi_status=wifi_status,.wifi_last_ssid=last_ssid,.wifi_security_class=security,.wifi_scan_start=scan_start,.wifi_scan_results=scan_results,.wifi_connect_start=connect_start,.wifi_disconnect_start=disconnect_start,.wifi_reconnect_start=disconnect_start,.wifi_forget_start=disconnect_start,.wifi_operation=wifi_operation,.wifi_hotspot_start=hotspot_start,.wifi_hotspot_stop=disconnect_start,.wifi_hotspot_status=hotspot_status};
void desktop_home(void){app_active=false;overlay=false;if(desktop_setup_active())return;aster_qpanel_on_app_stop();aster_launcher_app_touch_cancel();aster_gesture_reset();aster_launcher_on_registry_change();aster_launcher_show();}
void desktop_app(void){aster_launcher_hide();aster_gesture_reset();aster_launcher_app_touch_cancel();app_active=true;overlay=false;}
void desktop_app_pixels(const uint8_t *data,size_t size){if(size!=(size_t)desktop_width*desktop_height*2||overlay)return;write_plain(data,0,0,desktop_width,desktop_height,desktop_width);}
void desktop_frame(void){
 if(app_active){aster_touch_evt_t e;while(input_poll(&e,1)>0){bool consumed=false,down=e.action!=3;if(e.slot==0){aster_gest_t g=aster_gesture_feed(e.x,e.y,down,aster_qpanel_allow(false),desktop_height);consumed=aster_qpanel_on_gesture(g,ASTER_QPANEL_OVER_APP);if(g==ASTER_GEST_PANEL_UP||(!consumed&&!aster_qpanel_is_open()&&aster_launcher_app_touch(e.x,e.y,down))){aster_qpanel_request_exit("应用");consumed=true;}}if(aster_qpanel_is_open()||consumed)aster_ui_lvgl_pointer(e.x,e.y,down);else {char v[80];snprintf(v,sizeof(v),"%u %u %u %u",e.action,e.x,e.y,e.slot);desktop_event("touch",v);}}
  aster_qpanel_tick();if(aster_qpanel_is_open())aster_ui_lvgl_pump();if(aster_qpanel_take_exit_confirmed())desktop_event("home","");
  bool open=aster_qpanel_app_holds_glass();if(open!=overlay){overlay=open;desktop_event("overlay",open?"1":"0");}
 }else {if(desktop_setup_active()){if(aster_setup_ui_tick())goto present;desktop_setup_ack();}aster_launcher_pump_idle();}
 present:
 if(!changed)return;changed=false;const uint32_t header[]={0x4d495341,1,8+desktop_width*desktop_height*2,desktop_width,desktop_height};fwrite(header,1,sizeof(header),stdout);
 for(size_t i=0;i<(size_t)desktop_width*desktop_height;i++){uint16_t p=glass[i];wire[i]=(p>>8)|(p<<8);}fwrite(wire,2,desktop_width*desktop_height,stdout);fflush(stdout);
}
