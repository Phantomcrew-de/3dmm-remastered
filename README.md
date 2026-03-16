# 3D Movie Maker Remastered – Web Editor Prototype

This repository contains an **early browser-based editor prototype** for the **3D Movie Maker Remastered Project**.

The goal of the project is to recreate and modernize **Microsoft's 3D Movie Maker (1995)** as a **modern web application**, while preserving the charm and creative workflow of the original tool.

This prototype demonstrates early editor functionality such as:

* scene navigation
* character placement
* animation triggering
* recording actions into a timeline
* basic character controls

The editor currently runs locally through a simple Python server.

---

# Installation

Clone or download the entire repository into a folder:

```bash
git clone https://github.com/Phantomcrew-de/3dmm-remastered.git
cd 3dmm-remastered
```

Alternatively, download the repository as a ZIP and extract it.

---

# Running the Editor

Start a local Python server inside the project folder:

```bash
python -m http.server
```

Then open your browser and navigate to:

```
http://localhost:8000/3dmm-editor.html
```

---

# Display Requirements

To run the editor correctly:

* Use a **monitor with a 16:9 aspect ratio**
* Enter **fullscreen mode (F11)** in your browser

If the aspect ratio is different, you may experience a **Z-buffer offset**.
In this case, you can adjust the parameters in the **Developer Panel**.

Press **M** to open or close the Developer Panel.

---

# Basic Controls

### Recording

Recording starts after pressing **Rec** and then **dragging and dropping a character** into the scene.

---

### Character Movement

Move character:

* **Mouse left-click + drag**
* **W, A, S, D**
* **Arrow keys**

---

### Character Transform

Scale character:

```
Shift
```

Rotate character:

```
Alt
```

Move character up/down:

```
Ctrl
```

---

### Character Actions

Right-click on a character to open the **context menu** and configure movement or actions.

---

# Project Status

⚠️ This is an **early prototype** and many systems are still experimental.
Expect bugs, missing features, and ongoing changes.

The editor is being developed as part of the **3D Movie Maker Remastered community project**.

---

# Missing Sound Files

The **WAV files in the `SFX` folder are not included in this repository**.

These sound effects originate from the original **3D Movie Maker (1995)** and are therefore not distributed with this project.

To enable sound effects in the editor, you will need to **extract the WAV files from your own copy of the original 3D Movie Maker** and place them inside the `SFX` folder.

Once the files are present in the correct directory, the editor will automatically load and use them.

---

## License

MIT License

### 🤝 Author

Made with ❤️ & ☕️ ☕️ ☕️ ☕️ by Nico and Julius – [phantomcrew.eu](https://phantomcrew.eu/)

<br><a href="https://www.buymeacoffee.com/phantomcrew" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>
---

