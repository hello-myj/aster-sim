cmake_minimum_required(VERSION 3.20)
project(aster_desktop_core C)
set(CMAKE_C_STANDARD 11)
set(ASTER_FIRMWARE "${CMAKE_CURRENT_LIST_DIR}/../../../aster-firmware" CACHE PATH "Sibling firmware checkout")
get_filename_component(ASTER_FIRMWARE "${ASTER_FIRMWARE}" ABSOLUTE)
set(UI "${ASTER_FIRMWARE}/systems/zephyr/ui")
if(NOT EXISTS "${UI}/launcher/flux.c")
  message(FATAL_ERROR "Set ASTER_FIRMWARE to the firmware repository")
endif()
include("${ASTER_FIRMWARE}/common/setup/assets.cmake")
file(GLOB_RECURSE LV_SOURCES "${ASTER_FIRMWARE}/third_party/lvgl/src/*.c")
list(FILTER LV_SOURCES EXCLUDE REGEX "/(examples|tests|demos|libs)/")
list(FILTER LV_SOURCES EXCLUDE REGEX "/stdlib/(uefi|rtthread|micropython)/")
add_executable(aster-desktop-core core.c port.c audio.c setup.c
  "${ASTER_FIRMWARE}/systems/shared/setup/setup_ui.c"
  "${ASTER_FIRMWARE}/common/setup/aster_setup_core.c"
  "${ASTER_FIRMWARE}/third_party/qrcodegen/qrcodegen.c"
  "${ASTER_FIRMWARE}/platform/esp32s3/audio_effect_engine.c"
  "${ASTER_FIRMWARE}/common/port/aster_device.c"
  "${ASTER_FIRMWARE}/common/port/aster_os.c"
  "${ASTER_FIRMWARE}/common/port/aster_services.c"
  "${UI}/launcher/flux.c" "${UI}/launcher/flux_font.c" "${UI}/flux_draw.c"
  "${UI}/font_sd.c" "${UI}/ui_font.c" "${UI}/gesture.c" "${UI}/qpanel.c"
  "${UI}/wifi_settings.c" "${UI}/ui_splash.c"
  "${ASTER_FIRMWARE}/platform/esp32s3/touch_ui.c" "${ASTER_SYSTEM_FONT}"
  ${LV_SOURCES}
  "${ASTER_FIRMWARE}/third_party/lvgl/src/libs/bin_decoder/lv_bin_decoder.c"
  "${ASTER_FIRMWARE}/third_party/lvgl/src/libs/rle/lv_rle.c")
add_dependencies(aster-desktop-core aster_system_fonts)
target_include_directories(aster-desktop-core PRIVATE include . "${UI}" "${UI}/launcher"
  "${ASTER_FIRMWARE}/common/port" "${ASTER_FIRMWARE}/common/net"
  "${ASTER_FIRMWARE}/common/setup" "${ASTER_FIRMWARE}/third_party/qrcodegen"
  "${ASTER_FIRMWARE}/platform" "${ASTER_FIRMWARE}/platform/esp32s3"
  "${ASTER_FIRMWARE}/systems/zephyr/core" "${ASTER_FIRMWARE}/systems/zephyr/services"
  "${ASTER_FIRMWARE}/common/package" "${ASTER_FIRMWARE}/common/include"
  "${ASTER_FIRMWARE}/contract/include" "${ASTER_FIRMWARE}/third_party/lvgl" "${ASTER_FIRMWARE}/third_party/lvgl/src")
target_compile_definitions(aster-desktop-core PRIVATE
  CONFIG_ASTER_LVGL_MEM_KB=2048 CONFIG_ASTER_LAUNCHER_FLUX=1 CONFIG_ASTER_FLUX_ART_CACHE=8
  CONFIG_ASTER_AUDIO=1 CONFIG_ASTER_WIFI=1 CONFIG_ASTER_MDNS=0
  CONFIG_ASTER_AUDIO_RATE=16000 CONFIG_ASTER_AUDIO_BITS=16
  CONFIG_ASTER_FIRST_BOOT=1
  CONFIG_ASTER_DISPLAY_ROTATION=0 CONFIG_ASTER_SCREENSHOT=1
  LV_CONF_PATH="${UI}/lv_conf.h" LV_LVGL_H_INCLUDE_SIMPLE)
include("${ASTER_FIRMWARE}/common/distribution.cmake")
aster_configure_distribution(aster-desktop-core)
if(NOT WIN32)
  target_link_libraries(aster-desktop-core PRIVATE m)
endif()
