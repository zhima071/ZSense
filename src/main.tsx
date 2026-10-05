import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { GlobalIconTooltips } from './components/GlobalIconTooltips'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <GlobalIconTooltips />
  </React.StrictMode>,
)
