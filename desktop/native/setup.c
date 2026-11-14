/* Desktop first-boot service: the shared firmware UI and state machine. */
#include "desktop.h"
#include "aster_setup.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
static aster_setup_snapshot snapshot;
static bool required=true,teardown=true;
bool desktop_setup_active(void){return required||teardown;}
void desktop_setup_ack(void){teardown=false;}
bool aster_setup_poll(aster_setup_snapshot *out){*out=snapshot;return required;}
void aster_setup_get(aster_setup_snapshot *out){*out=snapshot;}
void aster_setup_begin(void){snapshot.state.phase=ASTER_SETUP_PROVISION;strcpy(snapshot.ssid,"Aster-Desktop");strcpy(snapshot.password,"DEMOONLY12345");desktop_event("setup","");}
void aster_setup_retry(void){aster_setup_begin();}
bool aster_setup_format_pending(void){return false;}
void aster_setup_format_ui_ready(void){}
void desktop_setup_command(const char *line){
 if(line[0]=='I'){
  bool ready=atoi(line+1)!=0;
  if(ready){required=false;snapshot.state.phase=ASTER_SETUP_DONE;}
  else if(!required||snapshot.state.phase==ASTER_SETUP_CHECK){required=true;teardown=true;snapshot.state.phase=ASTER_SETUP_WELCOME;}
 }else if(line[0]=='S'){
  unsigned phase,file,files,seconds;unsigned long long bytes,total;char name[64]={0};
  if(sscanf(line+1,"%u%llu%llu%u%u%u%63s",&phase,&bytes,&total,&file,&files,&seconds,name)>=6&&phase<=ASTER_SETUP_FORMAT){
   required=phase!=ASTER_SETUP_DONE;teardown=true;snapshot.state.phase=phase;snapshot.state.required=true;snapshot.state.bytes=bytes;snapshot.state.total=total;snapshot.state.file=file;snapshot.state.files=files;snapshot.seconds=seconds;snprintf(snapshot.file,sizeof(snapshot.file),"%s",name);
  }
 }else if(line[0]=='K'){snapshot.state.failed_phase=snapshot.state.phase;snapshot.state.phase=ASTER_SETUP_ERROR;snapshot.state.error=atoi(line+1);required=true;}
}
