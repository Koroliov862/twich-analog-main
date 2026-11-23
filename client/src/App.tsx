import { useEffect, useState } from 'react'
import { login,me,register,type User} from './api'
import './App.css'

type Mode = "login" | "register"

function App() {
  const [mode, setMode] = useState<Mode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [token, setToken] = useState<string |null>(() => localStorage.getItem("token"))
  const [user,setUser] = useState<User | null>(null)
  const [error,setError] = useState("")
  const [notice,setNotice] = useState("")
  const [busy,setBusy] = useState(false)

  // если есть сохраненные токены проверяем их через /me
  useEffect(() => {
    if (!token) {setUser(null);return}
    me()
    .then(setUser)
    .catch(() => {localStorage.removeItem('token');setToken(null);});
  },[token])

  const submit = async(e:React.FormEvent) => {
    e.preventDefault();
    setError(""); setNotice(""); setBusy(true);
    try {
      if (mode === "register") {
        await register(email, password);
        setNotice("Аккаунт создан. Вход в систему")
      }
      const {access_token} = await login(email, password)
      localStorage.setItem("token", access_token);
      setToken(access_token);
        } catch (err: any) {
      const serverDetail = err?.response?.data?.detail;
      if (typeof serverDetail === "string") {
        setError(serverDetail);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Неверный email или пароль");
      }
    } finally {
      setBusy(false);
    }
  }

  const logout = () => {
    localStorage.removeItem("token");
    setToken(null); setUser(null), setPassword("");
  }

  if (token && !user) return <div className="status-screen">Проверяем токен...</div>

  if (token && user) return (
    <div className="card profile-card">
      <h1>Ты в системе</h1>
      <div className="user-info">
        <p><span>ID:</span> {user.id}</p>
        <p><span>Email:</span> {user.email}</p>
      </div>
      <button className="logout-btn" onClick={logout}>Выйти</button>
    </div>
  )

  return (
    <form className="card" onSubmit={submit}>
      <h1>MASTURBEAST STREAM</h1>
      
      <div className="tabs">
        <button 
          type="button" 
          className={mode === "login" ? "active" : ""} 
          onClick={() => { setMode('login'); setError(""); setNotice("") }}
        >
          Вход
        </button>
        <button 
          type="button" 
          className={mode === "register" ? "active" : ""} 
          onClick={() => { setMode('register'); setError(""); setNotice("") }}
        >
          Регистрация
        </button>
      </div>

      <div className="field">
        <label>Email</label>
        <input 
          type="email" 
          required 
          value={email} 
          onChange={(e) => setEmail(e.target.value)} 
          placeholder="введите email"
        />
      </div>

      <div className="field">
        <label>Password</label>
        <input 
          type="password" 
          required 
          minLength={8} 
          value={password} 
          onChange={(e) => setPassword(e.target.value)} 
          placeholder="введите пароль"
        />
      </div>

      <button className="submit" disabled={busy}>
        {busy ? "Подожди..." : mode === "login" ? "Войти" : "Создать аккаунт"}
      </button>

      {error && <div className="message error">{error}</div>}
      {notice && !error && <div className="message notice">{notice}</div>}
    </form>
  )
}

export default App
