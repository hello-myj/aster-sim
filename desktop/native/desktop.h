#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "aster_services.h"
extern unsigned desktop_width,desktop_height;
extern uint64_t desktop_ms;
extern uint16_t *desktop_pixels;
void desktop_init(unsigned w,unsigned h,const char *sd);
void desktop_touch(int action,int x,int y,int slot);
void desktop_frame(void);
int desktop_audio_ui(const int16_t *pcm,size_t frames,unsigned gain,unsigned priority);
void desktop_audio_stop_ui(void);
void desktop_audio_command(const char *line);
void desktop_audio_tick(unsigned dt);
bool desktop_setup_active(void);
void desktop_setup_ack(void);
void desktop_setup_command(const char *line);
void desktop_home(void);
void desktop_app(void);
void desktop_app_pixels(const uint8_t *data,size_t size);
void desktop_event(const char *kind,const char *value);
void desktop_catalog_clear(void);
void desktop_catalog_add(const char *id,const char *name,const char *description,const char *version,const char *category);
