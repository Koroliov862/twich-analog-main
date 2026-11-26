import { useEffect, useRef, useState } from 'react'

type ChatMessage = {
  type: 'message' | 'system'
  room: string
  user_id?: number
  email?: string
  text: string
  timestamp: string
}

export function Chat({ token, room }: { token: string; room: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [connected, setConnected] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Собираем уникальных пользователей из истории чата
  useEffect(() => {
    const emails = messages
      .filter((m) => m.type === 'message' && m.email)
      .map((m) => m.email as string)
    setSuggestions(Array.from(new Set(emails)))
  }, [messages])

  // Управление WebSocket
  useEffect(() => {
    // Определяем, где мы находимся: локально или на туннеле
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    
    // Если локально - используем ws://127.0.0.1:8001
    // Если на туннеле - используем wss:// и тот же домен, но порт 8001
    const host = isLocal 
      ? '127.0.0.1:8001' 
      : window.location.host.replace('5173', '8001')
      
    const protocol = isLocal ? 'ws://' : 'wss://'

    const url = `${protocol}${host}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
    
    console.log("Подключаемся к WebSocket:", url) // Для отладки

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)
    ws.onmessage = (e) => {
      try {
        const msg: ChatMessage = JSON.parse(e.data)
        setMessages((prev) => [...prev.slice(-200), msg])
      } catch {}
    }

    return () => ws.close()
  }, [token, room])

  // Обработка ввода: если ввели @, показываем список
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setText(val)
    // Ищем @ и пробел после него
    const match = val.match(/@(\w*)$/)
    if (match) {
      setShowSuggestions(true)
    } else {
      setShowSuggestions(false)
    }
  }

  // Клик по предложению (автодополнение)
  const selectSuggestion = (email: string) => {
    // Заменяем @ на @email (и добавляем пробел)
    const newText = text.replace(/@(\w*)$/, `@${email} `)
    setText(newText)
    setShowSuggestions(false)
    // Фокус обратно в поле ввода
    inputRef.current?.focus()
  }

  const send = (e: React.FormEvent) => {
    e.preventDefault()
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const t = text.trim()
    if (!t) return
    ws.send(JSON.stringify({ text: t }))
    setText('')
    setShowSuggestions(false)
  }

  // Функция для выделения @username в сообщении
  const renderMessageText = (txt: string) => {
    // Регулярка для поиска @ и не-пробельных символов (приблизительно)
    const parts = txt.split(/(@[^\s]+)/g)
    return parts.map((part, index) => {
      if (part.startsWith('@')) {
        return (
          <span key={index} style={{ color: '#a970ff', fontWeight: 'bold' }}>
            {part}
          </span>
        )
      }
      return <span key={index}>{part}</span>
    })
  }

  return (
    <div className="chat">
      <div className="chat-header">
        Чат «{room}» {connected ? '🟢' : '🔴'}
      </div>
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={m.type === 'system' ? 'chat-system' : 'chat-msg'}>
            {m.type === 'system' ? (
              <em>{m.text}</em>
            ) : (
              <>
                <b>{m.email ?? `#${m.user_id}`}:</b>{' '}
                {renderMessageText(m.text)}
              </>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={send} className="chat-form" style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          value={text}
          onChange={handleInputChange}
          placeholder="Сообщение..."
          maxLength={500}
        />
        <button disabled={!connected}>Отправить</button>

        {/* Выпадающий список предложений */}
        {showSuggestions && suggestions.length > 0 && (
          <ul className="suggestions-list">
            {suggestions.map((email) => (
              <li
                key={email}
                onClick={() => selectSuggestion(email)}
                style={{
                  padding: '6px 10px',
                  cursor: 'pointer',
                  backgroundColor: '#222',
                  borderBottom: '1px solid #333',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#333')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#222')}
              >
                {email}
              </li>
            ))}
          </ul>
        )}
      </form>
    </div>
  )
}