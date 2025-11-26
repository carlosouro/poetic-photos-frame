# Poetic Memories 🖼️✨

**A smart digital photo frame that doesn't just display your photos—it tells their story.**

Poetic Memories is a Raspberry Pi-based digital photo frame that uses **Google's Gemini AI** to "see" your family photos and generate a unique, heartwarming poem or select a profound famous quote that matches the mood of the image.

It is designed to run on a **Raspberry Pi 4** connected to a **NAS** (Network Attached Storage) containing your photo library.

![Project Screenshot](https://via.placeholder.com/800x450.png?text=Poetic+Memories+Screenshot)
*(Replace this link with a real screenshot of your frame!)*

## ✨ Features

* **🤖 AI-Powered Narration:** Uses Gemini 1.5/2.5 Flash Vision to analyze every photo and generate a short poem or find a matching quote.
* **🌍 Multi-Language:** Randomly switches between **English** and **European Portuguese** (configurable in code).
* **⚡ Zero-Latency Transitions:** Implements "double-buffering" logic to pre-load the next image and AI text in the background, ensuring transitions are instant and smooth.
* **📂 Massive Library Support:** Custom indexing system handles libraries with tens of thousands of photos.
* **💾 Smart Caching:** Persists AI results to a local JSON database to minimize API calls and costs. If a photo appears again, the poem loads instantly from cache.
* **🔄 Auto-Maintenance:** Automatically runs an incremental re-index every night at 2:00 AM to pick up new photos added to your NAS.
* **🛠️ Touch Controls:** Tap anywhere to access a settings menu to change slideshow speed (10s–240s), force a re-index, or reload the app.
* **🛡️ Robust Error Handling:** Detects if the NAS is disconnected and displays a helpful system alert instead of crashing.

## 🛠️ Hardware Requirements

This project was built and tested with the following components:

* **Raspberry Pi 4 Model B** (2GB or 4GB recommended).
* **Waveshare 10.1inch Capacitive Touch Screen LCD** (HDMI interface).
* **Argon ONE V2 Case** (Keeps cables tidy by routing ports to the back).
* **MicroSD Card** (32GB+).
* **Official Raspberry Pi USB-C Power Supply**.
* **Network Attached Storage (NAS)** hosting your photo library.

## 🚀 Installation & Setup

### 1. Raspberry Pi Setup
1.  Install **Raspberry Pi OS (Desktop)** on your MicroSD card.
2.  Connect your screen and ensure touch drivers are installed (if needed for your specific screen).
3.  Connect to your network via Wi-Fi or Ethernet.

### 2. Mount your NAS
**Critical Step:** The application reads files from the local file system. You must mount your NAS photo folder to a local path on the Pi.

1.  Create a mount point:
    ```bash
    sudo mkdir -p /mnt/nas/photos
    ```
2.  Edit `/etc/fstab` to mount it automatically on boot:
    ```bash
    # Example for Synology/SMB
    //<NAS_IP>/photo /mnt/nas/photos cifs username=<USER>,password=<PASS>,iocharset=utf8,vers=3.0 0 0
    ```
3.  Test the mount:
    ```bash
    sudo mount -a
    ls /mnt/nas/photos
    ```

### 3. Application Setup
Clone the repository and install dependencies:

```bash
git clone [https://github.com/yourusername/poetic-memories.git](https://github.com/yourusername/poetic-memories.git)
cd poetic-memories
npm install
```

### 4. Configuration
Create a `.env` file in the root directory:

```ini
# Get a free key at [https://aistudio.google.com/](https://aistudio.google.com/)
GEMINI_API_KEY=your_google_ai_studio_key_here

# The local path where you mounted your NAS
NAS_ROOT_PATH=/mnt/nas/photos

# Optional: Override the model version
GEMINI_MODEL=gemini-2.5-flash

# Port for the web server
PORT=3000
```

### 5. First Run
Start the application:

```bash
npm start
```

* **First Boot:** The app will detect an empty library. It will attempt to load photos from a `_photoframe_defaults` folder (if you created one on your NAS) for instant display, then trigger a full background index of your entire library.
* **Browser:** Open Chromium and navigate to `http://localhost:3000`.

## 🖥️ Kiosk Mode (Auto-Start)

To make this a true appliance, set it to auto-start in full screen.

1.  Create a startup script `start-frame.sh`:
    ```bash
    #!/bin/bash
    cd /home/pi/poetic-memories
    npm start &
    sleep 5
    chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
    ```
2.  Make it executable: `chmod +x start-frame.sh`
3.  Add it to your desktop autostart configuration.

## 🏗️ Architecture

* **Backend (`src/server.ts`):** Node.js/Express server. Handles API requests, manages the photo library memory, talks to Google Gemini, and persists the cache (`photos.json`, `texts.json`) to disk.
* **Indexer (`src/indexer.ts`):** A separate child process spawned by the server. It recursively scans directories, sorts them (newest folders first), and streams found photos back to the main server via IPC.
* **Frontend (`public/index.html`):** A single-page application. Handles the display logic, double-buffering (pre-fetching), and touch interactions.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.