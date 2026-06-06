$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = "C:\Users\daubs\AppData\Local\Google\Chrome\User Data\sb-automation"
& $chrome --remote-debugging-port=9222 --user-data-dir="$profile"
