cmake_minimum_required(VERSION 3.16)
project(NeSVoRN4 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(ITK REQUIRED)
include(${ITK_USE_FILE})
add_executable(nesvor-n4 n4.cxx)
target_link_libraries(nesvor-n4 PRIVATE ${ITK_LIBRARIES})
if(EMSCRIPTEN)
  set_target_properties(nesvor-n4 PROPERTIES SUFFIX ".mjs")
  target_link_options(nesvor-n4 PRIVATE
    "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sEXPORT_NAME=createN4"
    "-sPTHREAD_POOL_SIZE=0" "-sALLOW_MEMORY_GROWTH=1"
    "-sMAXIMUM_MEMORY=4294967296" "-sINITIAL_MEMORY=67108864"
    "-sENVIRONMENT=web,worker,node"
    "-sEXPORTED_FUNCTIONS=['_n4_correct','_n4_error','_malloc','_free']"
    "-sEXPORTED_RUNTIME_METHODS=['UTF8ToString','HEAPU8','HEAPF32','HEAPF64','HEAPU32']"
    "-sINVOKE_RUN=0" "-sEXIT_RUNTIME=0")
endif()
