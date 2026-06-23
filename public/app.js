const state = {
  apiKey: sessionStorage.getItem("salesApiKey") || "",
  searchTimer: null
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  Object.assign(elements, {
    loginView: document.querySelector("#loginView"),
    dashboardView: document.querySelector("#dashboardView"),
    loginForm: document.querySelector("#loginForm"),
    loginError: document.querySelector("#loginError"),
    apiKey: document.querySelector("#apiKey"),
    toggleKey: document.querySelector("#toggleKey"),
    logoutButton: document.querySelector("#logoutButton"),
    refreshButton: document.querySelector("#refreshButton"),
    connectionStatus: document.querySelector("#connectionStatus"),
    searchInput: document.querySelector("#searchInput"),
    fromDate: document.querySelector("#fromDate"),
    toDate: document.querySelector("#toDate"),
    clearFilters: document.querySelector("#clearFilters"),
    totalSales: document.querySelector("#totalSales"),
    invoiceCount: document.querySelector("#invoiceCount"),
    itemsSold: document.querySelector("#itemsSold"),
    averageInvoice: document.querySelector("#averageInvoice"),
    salesChart: document.querySelector("#salesChart"),
    topProducts: document.querySelector("#topProducts"),
    invoiceRows: document.querySelector("#invoiceRows"),
    invoiceResultLabel: document.querySelector("#invoiceResultLabel"),
    emptyState: document.querySelector("#emptyState"),
    invoiceDialog: document.querySelector("#invoiceDialog"),
    closeDialog: document.querySelector("#closeDialog"),
    dialogTitle: document.querySelector("#dialogTitle"),
    dialogMeta: document.querySelector("#dialogMeta"),
    dialogItems: document.querySelector("#dialogItems"),
    dialogTotal: document.querySelector("#dialogTotal"),
    toast: document.querySelector("#toast")
  });

  bindEvents();
  refreshIcons();

  if (state.apiKey) {
    showDashboard();
    loadDashboard();
  }
});

function bindEvents() {
  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.loginError.textContent = "";
    state.apiKey = elements.apiKey.value.trim();
    if (!state.apiKey) return;

    try {
      await apiFetch("/api/ping.php");
      sessionStorage.setItem("salesApiKey", state.apiKey);
      showDashboard();
      await loadDashboard();
    } catch (error) {
      state.apiKey = "";
      elements.loginError.textContent =
        error.status === 401 ? "مفتاح الدخول غير صحيح." : "تعذر الاتصال بالخادم.";
    }
  });

  elements.toggleKey.addEventListener("click", () => {
    elements.apiKey.type = elements.apiKey.type === "password" ? "text" : "password";
  });

  elements.logoutButton.addEventListener("click", logout);
  elements.refreshButton.addEventListener("click", loadDashboard);
  elements.closeDialog.addEventListener("click", () => elements.invoiceDialog.close());

  elements.invoiceDialog.addEventListener("click", (event) => {
    if (event.target === elements.invoiceDialog) elements.invoiceDialog.close();
  });

  elements.searchInput.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadDashboard, 350);
  });

  elements.fromDate.addEventListener("change", loadDashboard);
  elements.toDate.addEventListener("change", loadDashboard);
  elements.clearFilters.addEventListener("click", () => {
    elements.searchInput.value = "";
    elements.fromDate.value = "";
    elements.toDate.value = "";
    loadDashboard();
  });
}

function showDashboard() {
  elements.loginView.hidden = true;
  elements.dashboardView.hidden = false;
  refreshIcons();
}

function logout() {
  sessionStorage.removeItem("salesApiKey");
  state.apiKey = "";
  elements.apiKey.value = "";
  elements.dashboardView.hidden = true;
  elements.loginView.hidden = false;
}

async function apiFetch(url) {
  const response = await fetch(url, {
    headers: { "X-Api-Key": state.apiKey }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadDashboard() {
  setLoading(true);
  const params = new URLSearchParams();
  if (elements.searchInput.value.trim()) params.set("search", elements.searchInput.value.trim());
  if (elements.fromDate.value) params.set("from", elements.fromDate.value);
  if (elements.toDate.value) params.set("to", elements.toDate.value);

  try {
    const data = await apiFetch(`/api/dashboard?${params}`);
    renderSummary(data.summary);
    renderChart(data.daily_sales);
    renderProducts(data.top_products);
    renderInvoices(data.invoices);
    setConnection(true);
  } catch (error) {
    if (error.status === 401) {
      logout();
      elements.loginError.textContent = "انتهت جلسة الدخول. أدخل المفتاح مرة أخرى.";
      return;
    }
    setConnection(false);
    showToast("تعذر تحديث البيانات. حاول مرة أخرى.");
  } finally {
    setLoading(false);
  }
}

function renderSummary(summary) {
  elements.totalSales.textContent = money(summary.total_sales);
  elements.invoiceCount.textContent = number(summary.invoice_count);
  elements.itemsSold.textContent = number(summary.items_sold);
  elements.averageInvoice.textContent = money(summary.average_invoice);
}

function renderChart(days) {
  if (!days.length) {
    elements.salesChart.innerHTML = emptyInline("لا توجد مبيعات في هذه الفترة");
    return;
  }

  const maximum = Math.max(...days.map((day) => Number(day.total_sales)), 1);
  elements.salesChart.innerHTML = days.map((day) => {
    const value = Number(day.total_sales);
    const height = Math.max((value / maximum) * 100, 3);
    return `
      <div class="bar-column" title="${escapeHtml(formatDate(day.sale_date))}: ${money(value)}">
        <div class="bar-track">
          <div class="bar" style="height:${height}%"></div>
        </div>
        <span>${escapeHtml(shortDate(day.sale_date))}</span>
      </div>`;
  }).join("");
}

function renderProducts(products) {
  if (!products.length) {
    elements.topProducts.innerHTML = emptyInline("لا توجد منتجات بعد");
    return;
  }

  const maximum = Math.max(...products.map((product) => Number(product.quantity)), 1);
  elements.topProducts.innerHTML = products.map((product) => `
    <div class="product-row">
      <strong title="${escapeHtml(product.product_name)}">${escapeHtml(product.product_name)}</strong>
      <span>${number(product.quantity)} قطعة</span>
      <div class="product-progress">
        <div style="width:${(Number(product.quantity) / maximum) * 100}%"></div>
      </div>
    </div>
  `).join("");
}

function renderInvoices(invoices) {
  elements.invoiceResultLabel.textContent = `${number(invoices.length)} فاتورة معروضة`;
  elements.emptyState.hidden = invoices.length > 0;
  elements.invoiceRows.innerHTML = invoices.map((invoice) => `
    <tr>
      <td>
        <button class="invoice-link" type="button" data-invoice-id="${invoice.local_invoice_id}">
          #${escapeHtml(String(invoice.local_invoice_id))}
        </button>
      </td>
      <td>${escapeHtml(formatDate(invoice.invoice_date))}</td>
      <td>${number(invoice.item_count)}</td>
      <td><strong>${money(invoice.invoice_total)}</strong></td>
      <td>
        <button class="icon-button view-button" type="button"
                title="عرض التفاصيل" data-invoice-id="${invoice.local_invoice_id}">
          <i data-lucide="chevron-left"></i>
        </button>
      </td>
    </tr>
  `).join("");

  elements.invoiceRows.querySelectorAll("[data-invoice-id]").forEach((button) => {
    button.addEventListener("click", () => openInvoice(button.dataset.invoiceId));
  });
  refreshIcons();
}

async function openInvoice(invoiceId) {
  try {
    const data = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}`);
    elements.dialogTitle.textContent = `فاتورة #${data.invoice.local_invoice_id}`;
    elements.dialogMeta.innerHTML = `
      <span>التاريخ: <strong>${escapeHtml(formatDate(data.invoice.invoice_date))}</strong></span>
      <span>عدد المنتجات: <strong>${number(data.items.length)}</strong></span>
    `;
    elements.dialogItems.innerHTML = data.items.map((item) => `
      <tr>
        <td>${escapeHtml(item.product_name)}</td>
        <td>${number(item.quantity)}</td>
        <td>${money(item.unit_price)}</td>
        <td><strong>${money(item.line_total)}</strong></td>
      </tr>
    `).join("");
    elements.dialogTotal.textContent = money(data.invoice.invoice_total);
    elements.invoiceDialog.showModal();
    refreshIcons();
  } catch {
    showToast("تعذر تحميل تفاصيل الفاتورة.");
  }
}

function setLoading(loading) {
  elements.refreshButton.disabled = loading;
  elements.refreshButton.classList.toggle("loading", loading);
}

function setConnection(online) {
  elements.connectionStatus.classList.toggle("offline", !online);
  elements.connectionStatus.lastChild.textContent = online ? " متصل" : " غير متصل";
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  setTimeout(() => elements.toast.classList.remove("visible"), 3000);
}

function money(value) {
  return `${new Intl.NumberFormat("ar-EG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0))} ج.م`;
}

function number(value) {
  return new Intl.NumberFormat("ar-EG").format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "-";
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: value.length > 10 ? "short" : undefined
  }).format(date);
}

function shortDate(value) {
  const parts = String(value).split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : value;
}

function emptyInline(message) {
  return `<div class="empty-state"><span>${escapeHtml(message)}</span></div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}
