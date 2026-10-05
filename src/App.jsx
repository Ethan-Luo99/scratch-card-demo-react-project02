import ScratchCardGrid from './scratch-card/ScratchCardGrid.jsx'
import './App.css'

function App() {
  return (
    <main className="app">
      <header className="app__header">
        <h1>刮刮卡</h1>
        <p className="app__tip">刮开涂层查看奖品，刮开一半自动全开</p>
      </header>
      <ScratchCardGrid />
    </main>
  )
}

export default App
