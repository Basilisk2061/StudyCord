# StudyCord

[StudyCord](https://www.studycord.me/) is an AI-powered student collaboration platform designed to make studying together easier and more productive.

## 🚀 Overview

StudyCord combines real-time messaging, voice and video communication, document sharing, semantic document search, and a RAG-powered AI Study Assistant for group learning.

## 🧩 What’s Included

- `Frontend/` - React application built with Vite
- `Backend/` - backend folder available for API or server logic
- `README.md` - project documentation and quick start instructions

## 🛠️ Tech Stack

- React
- Vite
- JavaScript
- CSS
- Supabase
- React Router DOM
- Axios
- Framer Motion

## ✅ Prerequisites

- Node.js 18+ or later
- npm

## 📥 Install Dependencies

From the repository root:

```bash
git clone https://github.com/Basilisk2061/StudyCord.git
cd StudyCord
```

Then install frontend dependencies:

```bash
cd Frontend
npm install
```

## ▶️ Run Locally

Start the frontend development server:

```bash
cd Frontend
npm run dev
```

Open the address shown in the terminal (usually `http://localhost:5173`).

## 📦 Build for Production

```bash
cd Frontend
npm run build
```

Preview the production build locally:

```bash
cd Frontend
npm run preview
```

## Backend LLM Providers

StudyCord sends generation requests to NVIDIA NIM first and uses the existing
OpenRouter integration only for eligible transient failures. Configure the
backend with:

```env
NVIDIA_API_KEY=your_nvidia_api_key
NVIDIA_MODEL=your_nvidia_nim_model_id
PRIMARY_LLM_PROVIDER=nvidia
FALLBACK_LLM_PROVIDER=openrouter
```

The existing `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` variables remain the
fallback provider configuration. Automatic fallback is limited to timeouts,
connection failures, quota/rate-limit failures, and HTTP 500, 502, 503, or 504
responses. Invalid credentials and malformed requests do not fall back.

## 📁 Frontend Structure

- `src/` - React application source files
- `src/components/` - reusable UI components
- `src/pages/` - application pages and routes
- `src/lib/` - app utilities and Supabase client
- `public/` - static assets

## 🤝 Contributing

Contributions and improvements are welcome. Please open an issue or create a pull request with your changes.

## 📄 License

This project is open source and available under the MIT License.
