import Foundation

// Stable identifier used for both the macOS LaunchAgent label and Nix-managed defaults suite.
// nix-afora writes app defaults into this suite to survive app bundle identifier churn.
let launchdLabel = "ai.afora.mac"
var gatewayLaunchdLabel: String {
    AppProfile.current.gatewayLaunchAgentLabel
}

let nodeLaunchdLabel = "ai.afora.node"
let onboardingVersionKey = "afora.onboardingVersion"
let onboardingSeenKey = "afora.onboardingSeen"
let onboardingSystemAgentPendingKey = "afora.onboardingSystemAgentPending"
// Pre-rename releases persisted pending activations under the Crestodian key.
let onboardingSystemAgentPendingRetiredKey = "afora.onboardingCrestodianPending"
let currentOnboardingVersion = 8
let pauseDefaultsKey = "afora.pauseEnabled"
let iconAnimationsEnabledKey = "afora.iconAnimationsEnabled"
let swabbleEnabledKey = "afora.swabbleEnabled"
let swabbleTriggersKey = "afora.swabbleTriggers"
let voiceWakeTriggerChimeKey = "afora.voiceWakeTriggerChime"
let voiceWakeSendChimeKey = "afora.voiceWakeSendChime"
let showDockIconKey = "afora.showDockIcon"
let defaultVoiceWakeTriggers = ["afora"]
let voiceWakeMaxWords = 32
let voiceWakeMaxWordLength = 64
let voiceWakeMicKey = "afora.voiceWakeMicID"
let voiceWakeMicNameKey = "afora.voiceWakeMicName"
let voiceWakeLocaleKey = "afora.voiceWakeLocaleID"
let voiceWakeAdditionalLocalesKey = "afora.voiceWakeAdditionalLocaleIDs"
let voicePushToTalkEnabledKey = "afora.voicePushToTalkEnabled"
let voiceWakeTriggersTalkModeKey = "afora.voiceWakeTriggersTalkMode"
let talkEnabledKey = "afora.talkEnabled"
let talkPhaseSoundsEnabledKey = "afora.talkPhaseSoundsEnabled"
let talkShiftToStopEnabledKey = "afora.talkShiftToStopEnabled"
let iconOverrideKey = "afora.iconOverride"
let connectionModeKey = "afora.connectionMode"
let remoteTargetKey = "afora.remoteTarget"
let remoteIdentityKey = "afora.remoteIdentity"
let remoteProjectRootKey = "afora.remoteProjectRoot"
let remoteCliPathKey = "afora.remoteCliPath"
let canvasEnabledKey = "afora.canvasEnabled"
let quickChatEnabledKey = "afora.quickChatEnabled"
let cameraEnabledKey = "afora.cameraEnabled"
let computerControlEnabledKey = "afora.computerControlEnabled"
let computerControlProviderKey = "afora.computerControlProvider"
let cookieSyncEnabledKey = "afora.cookieSyncEnabled"
let cookieSyncIntoProfileKey = "afora.cookieSyncIntoProfile"
let cookieSyncDomainsKey = "afora.cookieSyncDomains"

func isComputerControlEnabled(defaults: UserDefaults = AppDefaults.standard) -> Bool {
    // object(forKey:) preserves an explicit false; bool(forKey:) would conflate it with an unset default.
    defaults.object(forKey: computerControlEnabledKey) as? Bool ?? true
}

let activeComputerPresenceEnabledKey = "afora.activeComputerPresenceEnabled"
let locationModeKey = "afora.locationMode"
let locationPreciseKey = "afora.locationPreciseEnabled"
let peekabooBridgeEnabledKey = "afora.peekabooBridgeEnabled"
let deepLinkKeyKey = "afora.deepLinkKey"
let cliInstallPromptedVersionKey = "afora.cliInstallPromptedVersion"
let cliInstallPolicyKey = "afora.cliInstallPolicy"
let cliManagedRestartPendingKey = "afora.cliManagedRestartPending"
let postAppUpdateReceiptKey = "afora.postAppUpdateReceipt"
let lastLaunchedAppVersionKey = "afora.lastLaunchedAppVersion"
let cliValidatedExecutableKey = "afora.cliValidatedExecutable"
let cliValidatedVersionKey = "afora.cliValidatedVersion"
let macNodeIdentityProfileKey = "afora.macNodeIdentityProfile"
let heartbeatsEnabledKey = "afora.heartbeatsEnabled"
let debugPaneEnabledKey = "afora.debugPaneEnabled"
let nativeSettingsPanesEnabledKey = "afora.nativeSettingsPanesEnabled"
let debugFileLogEnabledKey = "afora.debug.fileLogEnabled"
let appLogLevelKey = "afora.debug.appLogLevel"
let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26
