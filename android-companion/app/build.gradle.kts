plugins { id("com.android.application") }

dependencies { implementation("org.bouncycastle:bcprov-jdk18on:1.80") }

android {
    namespace = "com.zsense.companion"
    compileSdk = 35
    buildFeatures { buildConfig = true }
    val releaseStore = System.getenv("ZSENSE_ANDROID_KEYSTORE")
    val releasePassword = System.getenv("ZSENSE_ANDROID_STORE_PASSWORD")
    val releaseAlias = System.getenv("ZSENSE_ANDROID_KEY_ALIAS")
    val releaseKeyPassword = System.getenv("ZSENSE_ANDROID_KEY_PASSWORD")
    if (!releaseStore.isNullOrBlank() && !releasePassword.isNullOrBlank() &&
        !releaseAlias.isNullOrBlank() && !releaseKeyPassword.isNullOrBlank()) {
        signingConfigs.create("localRelease") {
            storeFile = file(releaseStore)
            storePassword = releasePassword
            keyAlias = releaseAlias
            keyPassword = releaseKeyPassword
        }
    }
    defaultConfig {
        applicationId = "com.zsense.companion"
        minSdk = 33
        targetSdk = 35
        versionCode = 6
        versionName = "0.1.5"
        testInstrumentationRunner = "com.zsense.companion.RemoteInsetsInstrumentation"
        val hubUrl = providers.gradleProperty("zsenseHubUrl").orElse("https://hub.zsense.space").get()
        buildConfigField("String", "HUB_URL", "\"$hubUrl\"")
        manifestPlaceholders["cleartextTest"] = providers.gradleProperty("zsenseCleartextTest").orElse("false").get()
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildTypes.getByName("release") {
        signingConfig = signingConfigs.findByName("localRelease")
    }
}
