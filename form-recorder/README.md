# Form Autofill Recorder (Chrome Extension)

হাতে টাইপ করে form পূরণ করার সময় সেগুলো record করে রাখে, পরে **Play** চাপলে
একই form আবার auto-fill করে দেয়। একাধিক page (যেমন ৩টি ধাপের form) সাপোর্ট
করে — প্রতিটি page-এর data আলাদাভাবে save হয়।

## Install করার নিয়ম

1. Chrome-এ যান: `chrome://extensions`
2. উপরের ডান কোণে **Developer mode** চালু করুন
3. **Load unpacked** বাটনে ক্লিক করুন
4. এই `form-recorder` ফোল্ডারটি select করুন

## ব্যবহারের নিয়ম

### Record করা (প্রথমবার)

1. Form-এর page-এ যান
2. Extension আইকনে ক্লিক করে **⏺ Record শুরু করুন** চাপুন
   (page-এর কোণে লাল "Recording" ব্যানার দেখা যাবে)
3. স্বাভাবিকভাবে হাতে টাইপ করে form পূরণ করুন — সব input, dropdown,
   checkbox, radio button record হবে
4. পরের page-এ গেলে recording চালুই থাকবে — ৩টি page-ই এভাবে পূরণ করুন
5. শেষ হলে **⏹ Record বন্ধ করুন** চাপুন

Record চালু করার সময় page-এ আগে থেকে পূরণ করা ফিল্ডগুলোও সাথে সাথে save
হয়ে যায়, তাই আগে টাইপ করে পরে Record চাপলেও সমস্যা নেই।

### Play করা (পরবর্তীতে auto-fill)

1. Form-এর page-এ যান
2. Extension আইকনে ক্লিক করে **▶ Play (Auto-fill)** চাপুন
3. Record করা সব ফিল্ড অটো পূরণ হয়ে যাবে
4. পরের page-এ গিয়ে আবার **Play** চাপুন — ৩টি page-এই একইভাবে কাজ করবে

### Data মুছতে চাইলে

**🗑 এই page-এর data মুছুন** চাপলে শুধু বর্তমান page-এর recording মুছে যাবে।
নতুন করে record করলে পুরনো ভ্যালুর উপর overwrite হয়।

## যা জেনে রাখা ভালো

- **Password ও file ফিল্ড record হয় না** — নিরাপত্তার জন্য ইচ্ছা করেই বাদ
  রাখা হয়েছে।
- সব data আপনার নিজের ব্রাউজারে (`chrome.storage.local`) থাকে, কোথাও
  পাঠানো হয় না।
- ফিল্ড চেনা হয় `id`/`name` দিয়ে, তাই সাইট redesign হলে আবার record করা
  লাগতে পারে।
- React/Vue দিয়ে বানানো form-এও কাজ করে (native setter + input event
  দিয়ে ভ্যালু বসানো হয়)।
- Captcha, OTP — এসব প্রতিবার নতুন হয়, তাই এগুলো replay করা যায় না;
  সেগুলো হাতেই দিতে হবে।
