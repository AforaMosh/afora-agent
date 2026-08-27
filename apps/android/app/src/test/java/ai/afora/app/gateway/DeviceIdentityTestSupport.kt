package ai.afora.app.gateway

import ai.afora.app.SecurePrefs
import android.content.Context

internal fun testDeviceIdentityStore(context: Context): DeviceIdentityStore {
  val backing =
    context.getSharedPreferences(
      "afora.node.secure.test.device-identity",
      Context.MODE_PRIVATE,
    )
  return DeviceIdentityStore.withPrefs(
    context,
    SecurePrefs(context, securePrefsOverride = backing),
  )
}
