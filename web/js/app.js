class App {
  constructor() {
    this.currentPage = 'login';
    this.isReady = false;
    this.theme = localStorage.getItem('lynkbay_theme') || 'light';
    this.applyTheme(this.theme);
  }

  async init() {
    try {
      await window.db.init();
      await window.db.syncCustomersFromBills();
      // Ensure default product exists
      const prods = await window.db.getProducts();
      if (prods.length === 0) {
        await window.db.addProduct('Cashew Packet');
      }
    } catch (e) {
      console.error('DB Init error', e);
      alert('App failed to start. Please refresh and try again.');
      return;
    }
    
    window.auth.init();
    if (window.billing) await window.billing.init();
    if (window.historyView) window.historyView.init();
    if (window.inventory) await window.inventory.init();
    if (window.customersPage) window.customersPage.init();
    if (window.collectionPage) window.collectionPage.init();
    if (window.reportsView) window.reportsView.init();
    if (window.expensesPage) window.expensesPage.init();
    if (window.clearInputs) window.clearInputs.init();
    this.bindBackupButtons();
    this.bindThemeToggle();
    this.updateThemeToggle();
    this.updateBackupReminder();
    this.isReady = true;
    if (window.auth && typeof window.auth.setReadyState === 'function') {
      window.auth.setReadyState(true);
    }

    if (this.restoreReceiptNavigation()) {
      return;
    }

    if (!window.auth?.isAuthenticated) {
      this.navigate('login');
    }
  }

  applyTheme(theme) {
    const nextTheme = theme === 'dark' ? 'dark' : 'light';
    this.theme = nextTheme;
    document.documentElement.setAttribute('data-theme', nextTheme);
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', nextTheme === 'dark' ? '#0f1411' : '#ffffff');
  }

  setTheme(theme) {
    this.applyTheme(theme);
    localStorage.setItem('lynkbay_theme', this.theme);
    this.updateThemeToggle();
  }

  toggleTheme() {
    this.setTheme(this.theme === 'dark' ? 'light' : 'dark');
  }

  bindThemeToggle() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle || toggle.dataset.themeBound === '1') return;
    toggle.dataset.themeBound = '1';
    toggle.addEventListener('click', () => this.toggleTheme());
  }

  updateThemeToggle() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    const isDark = this.theme === 'dark';
    toggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    const icon = toggle.querySelector('.theme-toggle-icon');
    const text = toggle.querySelector('.theme-toggle-text');
    if (icon) icon.textContent = isDark ? '☀' : '☾';
    if (text) text.textContent = isDark ? 'Light Mode' : 'Dark Mode';
  }

  restoreReceiptNavigation() {
    const intentKey = 'receipt-nav-intent';
    let intent = null;

    try {
      intent = JSON.parse(localStorage.getItem(intentKey) || 'null');
    } catch (e) {
      intent = null;
    }

    localStorage.removeItem(intentKey);

    if (!intent || Date.now() - Number(intent.createdAt || 0) > 10 * 60 * 1000) {
      return false;
    }

    if (!localStorage.getItem('billing_user')) {
      return false;
    }

    if (window.auth) {
      window.auth.isAuthenticated = true;
    }

    if (intent.action === 'edit' && intent.bill && window.billing) {
      window.billing.setEditMode(intent.bill);
      return true;
    }

    this.navigate(intent.page || 'billing');
    return true;
  }

  navigate(pageId) {
    if (pageId !== 'login' && window.auth && !window.auth.isAuthenticated) {
      pageId = 'login';
    }

    document.querySelectorAll('.page').forEach(page => {
      page.classList.remove('active');
    });
    const page = document.getElementById(`${pageId}-page`);
    if (page) {
      page.classList.add('active');
      this.currentPage = pageId;

      const navBottom = document.getElementById('nav-bottom');
      if (navBottom) {
        navBottom.classList.toggle('hidden', pageId === 'login');
      }
      
      // Sync bottom nav
      document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
      });
      const navItem = document.getElementById(`nav-${pageId}`);
      if (navItem) navItem.classList.add('active');

      if (pageId === 'history' && window.historyView) {
        window.historyView.render();
      }
      if (pageId === 'inventory' && window.inventory) {
        window.inventory.render();
      }
      if (pageId === 'customers' && window.customersPage) {
        window.customersPage.render();
      }
      if (pageId === 'collection' && window.collectionPage) {
        window.collectionPage.render();
      }
      if (pageId === 'reports' && window.reportsView) {
        window.reportsView.render();
      }
      if (pageId === 'expenses' && window.expensesPage) {
        window.expensesPage.render();
      }
      if (pageId === 'billing') {
        this.updateBackupReminder();
        if (window.billing) {
          window.billing.refreshProducts();
          window.billing.loadCustomerDirectory();
          window.billing.loadOutstandingDirectory();
        }
      }
    }
  }

  bindBackupButtons() {
    ['btn-quick-backup', 'btn-reminder-backup'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn || btn.dataset.backupBound === '1') return;
      btn.dataset.backupBound = '1';
      btn.addEventListener('click', () => this.exportBackup('manual'));
    });
  }

  getLastBackupTime() {
    return Number(localStorage.getItem('last_backup_at') || '0') || 0;
  }

  updateBackupReminder() {
    const reminder = document.getElementById('backup-reminder');
    const text = document.getElementById('backup-reminder-text');
    if (!reminder || !text) return;

    const last = this.getLastBackupTime();
    const ageMs = Date.now() - last;
    const due = !last || ageMs > 24 * 60 * 60 * 1000;
    reminder.classList.toggle('hidden', !due);

    if (!last) {
      text.textContent = 'No backup created yet. Create one before using the app heavily.';
      return;
    }

    const lastText = new Date(last).toLocaleString();
    text.textContent = `Last backup: ${lastText}. Create a fresh backup daily.`;
  }

  async exportBackup(reason = 'manual') {
    try {
      const payload = await window.db.exportAllData();
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = url;
      a.download = `billing-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      localStorage.setItem('last_backup_at', String(Date.now()));
      await window.db.addAuditLog({
        action: 'backup_export',
        entity: 'backup',
        details: { reason }
      });
      this.updateBackupReminder();
      return true;
    } catch (err) {
      alert('Backup export failed.');
      console.error(err);
      return false;
    }
  }

  openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
  }

  closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
  }

  logout() {
    const confirmed = confirm('Log out now?');
    if (!confirmed) return;

    if (window.auth) {
      window.auth.logout();
    }

    document.querySelectorAll('.modal-overlay').forEach(modal => {
      modal.classList.remove('active');
    });
    document.getElementById('auth-pass').value = '';
    this.navigate('login');
  }
}

window.app = new App();

document.addEventListener('DOMContentLoaded', () => {
  window.app.init();
  
  // Close modals when clicking overlay
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });
  });
});
