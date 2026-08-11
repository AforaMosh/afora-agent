package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.chat.resolveChatComposerOwner
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w360dp-h720dp-420dpi")
class ChatComposerLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  private var originalRuntime: NodeRuntime? = null

  @After
  fun restoreRuntime() {
    runtimeField().set(RuntimeEnvironment.getApplication() as NodeApp, originalRuntime)
  }

  @Before
  fun disableAnimations() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @Test
  fun compactComposerPreservesEditorWidthAndEveryUtilityAction() {
    setChatScreen()

    val editorBounds =
      composeRule
        .onNodeWithTag("chat-composer-editor")
        .assertIsDisplayed()
        .getUnclippedBoundsInRoot()
    val attachImage = composeRule.onNodeWithContentDescription("Attach image").assertIsDisplayed()
    val attachDocument = composeRule.onNodeWithContentDescription("Attachment").assertIsDisplayed()
    val attachVideo = composeRule.onNodeWithContentDescription("Attach video").assertIsDisplayed()
    val voiceAction = composeRule.onNodeWithTag("chat-composer-voice-action").assertIsDisplayed()

    assertTrue("compact editor should remain at least 240dp wide", editorBounds.right - editorBounds.left >= 240.dp)
    assertTrue(
      "utility actions should stack below the editor row",
      attachImage.getUnclippedBoundsInRoot().top >= editorBounds.bottom,
    )
    listOf(attachImage, attachDocument, attachVideo, voiceAction).forEach { action ->
      action.assertWidthIsEqualTo(48.dp).assertHeightIsEqualTo(48.dp)
    }
  }

  @Test
  fun compactComposerKeepsTalkAndSendActionsAvailable() {
    val viewModel = setChatScreen()

    composeRule
      .onNodeWithContentDescription("Start Talk")
      .assertIsDisplayed()
      .assertWidthIsEqualTo(48.dp)
      .assertHeightIsEqualTo(48.dp)
    composeRule.runOnIdle {
      viewModel.chatComposerState.textDrafts[compactScreenComposerOwner(viewModel)] = "A compact-screen draft"
    }
    composeRule
      .onNodeWithContentDescription("Send")
      .assertIsDisplayed()
      .assertWidthIsEqualTo(48.dp)
      .assertHeightIsEqualTo(48.dp)
  }

  private fun setChatScreen(): MainViewModel {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs =
      SecurePrefs(
        app,
        securePrefsOverride =
          app.getSharedPreferences(
            "chat-composer-layout-${UUID.randomUUID()}",
            Context.MODE_PRIVATE,
          ),
      )
    // ChatScreen loads immediately; keep that public lifecycle real without device-only keystore state.
    originalRuntime = runtimeField().get(app) as NodeRuntime?
    runtimeField().set(app, NodeRuntime(app, prefs))
    val viewModel = MainViewModel(app = app, prefs = prefs, savedStateHandle = SavedStateHandle())
    composeRule.setContent {
      ClawDesignTheme {
        ChatScreen(
          viewModel = viewModel,
          talkActive = false,
          showSidebarButton = false,
          onOpenSidebar = {},
          onToggleTalk = {},
          onOpenSessions = {},
          onOpenDashboard = {},
          onOpenGatewaySettings = {},
        )
      }
    }
    return viewModel
  }

  private fun compactScreenComposerOwner(viewModel: MainViewModel) =
    resolveChatComposerOwner(
      gatewayStableId = viewModel.activeGatewayStableId.value,
      gatewayDefaultAgentId = viewModel.gatewayDefaultAgentId.value,
      lastVerifiedOwner = viewModel.gatewayComposerDefaultAgentOwner.value,
      sessionKey = viewModel.chatSessionKey.value,
      mainSessionKey = viewModel.mainSessionKey.value,
    )

  private fun runtimeField() =
    NodeApp::class.java.getDeclaredField("runtimeInstance").apply { isAccessible = true }
}
