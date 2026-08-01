<div align="center">
  <img
    width="918"
    alt="Syncronix Lab"
    src="./assets/syncronix-lab-logo.png"
  />
</div>

# Run and deploy your AI Studio app

This repository contains everything you need to run the Syncronix Lab application locally.

## View in AI Studio

[Open the application in Google AI Studio](https://ai.studio/apps/10e697d7-e2fc-4a55-8f69-c9c2cad50d65)

## Run locally

### Prerequisites

* Node.js
* A Gemini API key

### Installation

1. Clone the repository:

```bash
git clone URL_DE_TU_REPOSITORIO
cd NOMBRE_DEL_REPOSITORIO
```

2. Install the dependencies:

```bash
npm install
```

3. Open the `.env.local` file and add your Gemini API key:

```env
GEMINI_API_KEY=TU_CLAVE_DE_GEMINI
```

4. Start the development server:

```bash
npm run dev
```
