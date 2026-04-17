# Le Spectrogram

A simple, lightweight web-based spectrogram utility for real-time audio visualization from your microphone.

## What is this?

Le Spectrogram is a straightforward tool that captures audio from your microphone and displays it as a real-time spectrogram (also called a waterfall diagram). This visualizes the frequency content of audio over time, making it useful for voice analysis, music production, and audio monitoring.

## Features

- Real-time audio input from your microphone
- Live spectrogram visualization
- Multiple frequency scale options:
  - **Mel** (default) - perceptually weighted scale
  - **Linear** - standard linear frequency
  - **Octave** - logarithmic octave-based scale
  - **Log** - logarithmic frequency scale
- Privacy-first design - all data stays on your device by default
- Dark mode UI with Bootstrap styling
- Browser-based - no installation required
- Color blind friendly palette option
- Pause, resume, and reset controls

## How to Use

1. Open `index.html` in your web browser
2. Click the **"Start"** button
3. Allow access to your microphone when prompted
4. The spectrogram will begin displaying real-time audio visualization
5. Use the **"Scale Options"** dropdown to change the frequency scale

## Technologies Used

- **Spectrogram Library**: [Spectrogram-2v02.js](https://www.arc.id.au/Spectrogram.html) by Dr. A.R. Collins
- **UI Framework**: [Bootstrap 5.3.8](https://getbootstrap.com/) (Darkly theme)
- **Audio API**: Web Audio API
- **Display**: HTML5 Canvas


## Installation

No installation needed! Simply:

1. Clone or download this repository
2. Open `index.html` in any modern web browser
3. That's it!

## Browser Requirements

- Modern browser with Web Audio API support (Chrome, Firefox, Safari, Edge)
- Microphone access permission