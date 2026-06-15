// =============================================================
// app.js - Xử lý logic Frontend (Vanilla JS)
// =============================================================

// URL của Cloudflare Worker đã deploy lên production
// Giao thức "wss://" = WebSocket Secure (tương tự như HTTPS cho WebSocket)
// Bắt buộc dùng wss:// khi Worker chạy trên HTTPS của Cloudflare
const BACKEND_URL = 'wss://khong-gian-chung-backend.huynhphongdat2005.workers.dev/api/room';

document.addEventListener('DOMContentLoaded', () => {
  // Các phần tử DOM
  const loginScreen = document.getElementById('login-screen');
  const spaceScreen = document.getElementById('space-screen');
  const joinForm = document.getElementById('join-form');
  const usernameInput = document.getElementById('username-input');
  
  const universe = document.getElementById('universe');
  const connectionStatus = document.getElementById('connection-status');
  const onlineCount = document.getElementById('online-count');

  let ws = null;
  let currentUser = '';

  // ----------------------------------------------------------------
  // Xử lý Form Đăng nhập
  // ----------------------------------------------------------------
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = usernameInput.value.trim();
    if (name) {
      currentUser = name;
      connectToSpace(name);
    }
  });

  // ----------------------------------------------------------------
  // Hàm kết nối WebSocket đến Backend Worker
  // ----------------------------------------------------------------
  function connectToSpace(username) {
    // 1. Chuyển đổi màn hình (ẩn màn hình login, hiện màn hình không gian)
    loginScreen.classList.remove('active');
    spaceScreen.classList.add('active');
    
    connectionStatus.textContent = 'Đang kết nối WebSocket...';

    // 2. Khởi tạo WebSocket kết nối (kèm username trên query string)
    // Mã hóa username để an toàn khi truyền qua URL
    const encodedName = encodeURIComponent(username);
    ws = new WebSocket(`${BACKEND_URL}?username=${encodedName}`);

    // ----------------------------------------------------------------
    // Lắng nghe các sự kiện WebSocket
    // ----------------------------------------------------------------
    
    // Khi kết nối thành công
    ws.onopen = () => {
      console.log('Đã kết nối thành công tới Không Gian Chung!');
      connectionStatus.textContent = 'Đã kết nối';
      connectionStatus.style.color = '#00f3ff';
    };

    // Khi nhận được tin nhắn từ Server (Durable Object)
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Phân loại thông điệp
        if (data.type === 'user_list') {
          // Cập nhật số lượng
          onlineCount.textContent = data.count;
          // Render danh sách user trôi nổi
          renderUniverse(data.users);
        } else if (data.type === 'welcome') {
          console.log(data.message);
        } else if (data.type === 'chat') {
          console.log(`[${data.username}]: ${data.message}`);
        }
      } catch (err) {
        console.error('Lỗi khi phân tích dữ liệu:', err);
      }
    };

    // Khi kết nối bị đóng (mất mạng, server sập...)
    ws.onclose = () => {
      console.log('Kết nối đã bị đóng.');
      connectionStatus.textContent = 'Mất kết nối. Vui lòng tải lại trang.';
      connectionStatus.style.color = '#ff0055';
      document.querySelector('.dot').classList.remove('online');
    };

    // Khi có lỗi WebSocket
    ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
      connectionStatus.textContent = 'Lỗi kết nối!';
    };
  }

  // ----------------------------------------------------------------
  // Hàm hiển thị (Render) các user trong Không Gian
  // Lấy ý tưởng: các user sẽ được xếp ngẫu nhiên trên màn hình
  // ----------------------------------------------------------------
  function renderUniverse(users) {
    // Xóa nội dung vũ trụ cũ
    universe.innerHTML = '';

    // Kích thước của vùng chứa (để tính toán tọa độ ngẫu nhiên không bị tràn)
    // Trừ đi một khoảng (khoảng 150px rộng, 50px cao) để text không lọt ra ngoài màn hình
    const maxX = universe.clientWidth - 150; 
    const maxY = universe.clientHeight - 80;

    users.forEach((user, index) => {
      // Tạo một div cho mỗi user
      const userDiv = document.createElement('div');
      userDiv.className = 'floating-user';
      
      // Nếu là chính mình, có thể đổi màu cho dễ nhận diện
      if (user === currentUser) {
        userDiv.style.color = '#ff00ff'; // Màu hồng neon
        userDiv.style.borderColor = 'rgba(255, 0, 255, 0.3)';
        userDiv.textContent = `${user} (Bạn)`;
      } else {
        userDiv.textContent = user;
      }

      // Xếp vị trí lộn xộn/ngẫu nhiên
      // Dùng Math.random() để lấy tọa độ % hoặc pixel
      // Đảm bảo không bị quá sát lề màn hình
      const randomX = Math.max(20, Math.floor(Math.random() * maxX));
      const randomY = Math.max(80, Math.floor(Math.random() * maxY)); // Tránh thanh header ở trên

      userDiv.style.left = `${randomX}px`;
      userDiv.style.top = `${randomY}px`;

      // Tạo một chút độ trễ cho animation (delay ngẫu nhiên) để không trôi đồng loạt
      userDiv.style.animationDelay = `${(Math.random() * 2).toFixed(2)}s`;

      // Thêm user vào vũ trụ
      universe.appendChild(userDiv);
    });
  }
});
