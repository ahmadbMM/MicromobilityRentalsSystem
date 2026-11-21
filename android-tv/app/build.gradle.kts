import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI passes -PtvVersionCode=<github.run_number>; local builds get 1.
val tvVersionCode = (findProperty("tvVersionCode") as String?)?.toIntOrNull() ?: 1

// The release key comes from the environment (CI decodes it from repo secrets).
// Without it, release builds are signed with the debug key so the build never fails.
val keystorePath: String = System.getenv("TV_KEYSTORE_FILE").orEmpty()
val hasReleaseKey = keystorePath.isNotBlank() && file(keystorePath).exists()

android {
    namespace = "sa.micromobility.display"
    compileSdk = 35

    defaultConfig {
        applicationId = "sa.micromobility.display"
        minSdk = 21
        targetSdk = 35
        versionCode = tvVersionCode
        versionName = "1.0.$tvVersionCode"
    }

    buildFeatures {
        buildConfig = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("prod") {
            dimension = "env"
            buildConfigField("String", "DISPLAY_URL", "\"https://staff.micromobility.sa/display\"")
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
            buildConfigField("String", "DISPLAY_URL", "\"https://micromobility-staff-staging.pages.dev/display\"")
        }
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("TV_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TV_KEY_ALIAS")
                keyPassword = System.getenv("TV_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (hasReleaseKey) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // A lint warning must never stop the TVs from getting a build.
        abortOnError = false
        checkReleaseBuilds = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}
