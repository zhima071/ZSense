#include <CoreGraphics/CGWindow.h>
#include <node_api.h>
#include <pthread.h>

/* Loading this module only registers the function. The caller must invoke it
 * from an explicit user action in the Electron main process. Apple's standard
 * request does not re-prompt a previously denied process or bypass TCC. */
static napi_value request_screen_capture_permission(napi_env env,
                                                    napi_callback_info info) {
  (void)info;
  if (!pthread_main_np()) {
    napi_throw_error(env, "ERR_SCREEN_PERMISSION_MAIN_THREAD",
                     "Screen capture permission must be requested on the main thread.");
    return NULL;
  }

  const bool granted = CGRequestScreenCaptureAccess();
  napi_value result;
  if (napi_get_boolean(env, granted, &result) != napi_ok) {
    napi_throw_error(env, "ERR_SCREEN_PERMISSION_RESULT",
                     "Unable to return the screen capture permission result.");
    return NULL;
  }
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor property = {
      .utf8name = "requestScreenCapturePermission",
      .method = request_screen_capture_permission,
      .attributes = napi_enumerable,
  };
  if (napi_define_properties(env, exports, 1, &property) != napi_ok) {
    napi_throw_error(env, "ERR_SCREEN_PERMISSION_INITIALIZATION",
                     "Unable to initialize the screen capture permission module.");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(screen_permission, initialize)
