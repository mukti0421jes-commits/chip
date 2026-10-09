plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.arif.SMSForwarder"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.rj.smsforwarder"
        minSdk = 24
        targetSdk = 36
        versionCode = 3
        versionName = "3.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.1"
    }
}

dependencies {
    // WorkManager (Background Task)
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Jetpack Compose (UI Toolkit)
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation(platform("androidx.compose:compose-bom:2024.05.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")

    // Google Fonts
    implementation("androidx.compose.ui:ui-text-google-fonts")

    // Material Icons
    implementation("androidx.compose.material:material-icons-extended:1.6.7")

    // Core KTX
    implementation("androidx.core:core-ktx:1.13.1")

    // Lifecycle Runtime KTX
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.1")

    // --- সমাধান: Gson লাইব্রেরি (লগ সেভ করার জন্য) ---
    implementation("com.google.code.gson:gson:2.10.1")

    // Test
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.05.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")

    // Debug
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}