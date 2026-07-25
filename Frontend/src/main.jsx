  import { StrictMode } from 'react'
  import { createRoot } from 'react-dom/client'
  import './index.css'
  import App from './App.jsx'   

  createRoot(document.getElementById('root')).render(    //finds root in index.html to takeover point
    <StrictMode>
      <App />       
    </StrictMode>,
  )

  // App -> mounts entire app into App.jsx

