package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

var (
	jwtSecret = []byte(os.Getenv("JWT_SECRET_KEY"))

	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		// для локалки. В проде — проверять Origin
		CheckOrigin: func(r *http.Request) bool { return true },
	}
)

// --- сообщения ---

type Incoming struct {
	Text string `json:"text"`
}

type Outgoing struct {
	Type      string    `json:"type"` // "message" | "system" | "error"
	Room      string    `json:"room"`
	UserID    int       `json:"user_id,omitempty"`
	Email     string    `json:"email,omitempty"`
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp"`
}

// --- клиент ---

type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	send   chan Outgoing
	roomID string
	userID int
	email  string
}

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 4096
	maxTextRunes   = 500
	historyLimit   = 100
)

// --- комната ---

type Room struct {
	id         string
	clients    map[*Client]bool
	broadcast  chan Outgoing
	register   chan *Client
	unregister chan *Client
	history    []Outgoing
}

func (r *Room) run() {
	for {
		select {
		case c := <-r.register:
			r.clients[c] = true
			// отдаём историю новому клиенту
			for _, m := range r.history {
				select {
				case c.send <- m:
				default:
				}
			}
		case c := <-r.unregister:
			if _, ok := r.clients[c]; ok {
				delete(r.clients, c)
				close(c.send)
			}
		case m := <-r.broadcast:
			r.history = append(r.history, m)
			if len(r.history) > historyLimit {
				r.history = r.history[len(r.history)-historyLimit:]
			}
			for c := range r.clients {
				select {
				case c.send <- m:
				default:
					// медленный клиент — выкидываем
					close(c.send)
					delete(r.clients, c)
				}
			}
		}
	}
}

// --- хаб комнат ---

type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

func NewHub() *Hub { return &Hub{rooms: make(map[string]*Room)} }

func (h *Hub) getRoom(id string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[id]
	if !ok {
		r = &Room{
			id:         id,
			clients:    make(map[*Client]bool),
			broadcast:  make(chan Outgoing, 64),
			register:   make(chan *Client),
			unregister: make(chan *Client),
		}
		h.rooms[id] = r
		go r.run()
	}
	return r
}

// --- pumps ---

func (c *Client) readPump() {
	defer func() {
		c.hub.getRoom(c.roomID).unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}

		var in Incoming
		if err := json.Unmarshal(data, &in); err != nil {
			continue
		}

		text := strings.TrimSpace(in.Text)
		if text == "" || len([]rune(text)) > maxTextRunes {
			continue
		}

		c.hub.getRoom(c.roomID).broadcast <- Outgoing{
			Type:      "message",
			Room:      c.roomID,
			UserID:    c.userID,
			Email:     c.email,
			Text:      text,
			Timestamp: time.Now().UTC(),
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteJSON(msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// --- JWT ---

func parseToken(tokenStr string) (int, string, error) {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return 0, "", jwt.ErrTokenInvalidClaims
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return 0, "", jwt.ErrTokenInvalidClaims
	}
	sub, _ := claims["sub"].(string)
	email, _ := claims["email"].(string)
	id, err := strconv.Atoi(sub)
	if err != nil || id == 0 {
		return 0, "", jwt.ErrTokenInvalidClaims
	}
	return id, email, nil
}

// --- HTTP ---

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		roomID = "main"
	}
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}
	userID, email, err := parseToken(tokenStr)
	if err != nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade error:", err)
		return
	}

	client := &Client{
		hub:    h,
		conn:   conn,
		send:   make(chan Outgoing, 32),
		roomID: roomID,
		userID: userID,
		email:  email,
	}

	room := h.getRoom(roomID)
	room.register <- client

	// системное сообщение «зашёл»
	room.broadcast <- Outgoing{
		Type:      "system",
		Room:      roomID,
		UserID:    userID,
		Email:     email,
		Text:      email + " присоединился к чату",
		Timestamp: time.Now().UTC(),
	}

	go client.writePump()
	client.readPump()
}

func main() {
	if len(jwtSecret) == 0 {
		log.Fatal("JWT_SECRET_KEY is not set")
	}

	port := os.Getenv("CHAT_PORT")
	if port == "" {
		port = "8001"
	}

	hub := NewHub()
	http.HandleFunc("/ws", hub.ServeWS)
	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	log.Println("chat service listening on :" + port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
