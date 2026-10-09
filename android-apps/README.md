# Android SMS Forwarder Apps

এই ফোল্ডারে দুটি Android (Kotlin / Jetpack Compose) অ্যাপ আছে। দুটিই ফোনে আসা
SMS একটি সার্ভারে (PHP) ফরওয়ার্ড করে, যেখান থেকে OTP পড়া যায়।

## 1. Thirdey2-sms
- **অ্যাপের নাম:** Thirdey2 sms
- **applicationId:** `com.arif.SMSForwarder`
- **আইকন:** Mystic Eye (বেগুনি চোখ)
- **সার্ভার:** `https://thirdeyesms.xyz/sms.php`

## 2. RJ-SMS-Forwarder
- **অ্যাপের নাম:** RJ SMS Forwarder
- **applicationId:** `com.rj.smsforwarder`
- **আইকন:** Paper-plane (টিল/সবুজ)
- **সার্ভার:** `https://duttauzzal.shop/sms.php`
- **বাড়তি:** ড্যাশবোর্ডে Test বাটন

> দুটির applicationId আলাদা, তাই একই ফোনে পাশাপাশি ইনস্টল থাকতে পারে।

## সাধারণ ফিচার
- SIM detection (কোন সিমে SMS এসেছে তা শনাক্ত)
- WorkManager দিয়ে অটো retry (নেট ফিরলে আবার পাঠায়)
- Foreground Service + Boot Receiver + WakeLock (ব্যাকগ্রাউন্ডে চলে)

## বিল্ড করার নিয়ম
1. সংশ্লিষ্ট ফোল্ডারটি Android Studio তে `File > Open` দিয়ে খুলুন
2. Gradle sync শেষ হতে দিন (JVM 21 ব্যবহার করুন)
3. `Build > Generate APKs` → APK ফোনে ইনস্টল করুন

## সেটিংস (সোর্সে যেখানে বদলানো যায়)
- সার্ভার URL: `app/src/main/java/com/rupon/SMSForwarder/NetworkManager.kt` ও `ForwardingWorker.kt`
- অ্যাপের নাম: `app/src/main/res/values/strings.xml`
- applicationId: `app/build.gradle.kts`
