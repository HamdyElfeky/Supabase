const state = {
  apiKey: sessionStorage.getItem("salesApiKey") || "",
  currentView: location.hash === "#invoices" ? "invoices" : "overview",
  invoices: [],
  page: 1,
  pageSize: 20,
  searchTimer: null,
  selectedInvoiceId: null
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  const ids = [
    "loginView", "dashboardView", "loginForm", "loginError", "apiKey", "toggleKey",
    "logoutButton", "refreshButton", "connectionStatus", "lastUpdated", "pageEyebrow",
    "pageTitle", "overviewView", "invoicesView", "showAllInvoices", "searchInput",
    "fromDate", "toDate", "invoiceSort", "clearFilters", "exportInvoices",
    "totalSales", "invoiceCount", "itemsSold", "averageInvoice", "salesChart",
    "topProducts", "recentInvoices", "invoiceRows", "invoiceResultLabel", "emptyState",
    "filteredInvoiceCount", "filteredInvoiceTotal", "largestInvoice", "previousPage",
    "nextPage", "pageLabel", "invoiceDialog", "closeDialog", "dialogTitle",
    "dialogMeta", "dialogItems", "dialogTotal", "copyInvoiceNumber", "printInvoice",
    "toast"
  ];
  ids.forEach((id) => { elements[id] = document.querySelector(`#${id}`); });
  elements.navItems = [...document.querySelectorAll("[data-view]")];
  elements.periodButtons = [...document.querySelectorAll("[data-period]")];

  bindEvents();
  refreshIcons();

  if (state.apiKey) {
    showDashboard();
    switchView(state.currentView, false);
    loadDashboard();
  }
});

function bindEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.toggleKey.addEventListener("click", () => {
    elements.apiKey.type = elements.apiKey.type === "password" ? "text" : "password";
  });
  elements.logoutButton.addEventListener("click", logout);
  elements.refreshButton.addEventListener("click", loadDashboard);
  elements.closeDialog.addEventListener("click", () => elements.invoiceDialog.close());
  elements.invoiceDialog.addEventListener("click", (event) => {
    if (event.target === elements.invoiceDialog) elements.invoiceDialog.close();
  });
  elements.navItems.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  elements.showAllInvoices.addEventListener("click", () => switchView("invoices"));
  elements.periodButtons.forEach((button) => {
    button.addEventListener("click", () => applyPeriod(button.dataset.period));
  });
  elements.searchInput.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.page = 1;
      loadDashboard();
    }, 350);
  });
  elements.fromDate.addEventListener("change", filtersChanged);
  elements.toDate.addEventListener("change", filtersChanged);
  elements.invoiceSort.addEventListener("change", () => {
    state.page = 1;
    renderInvoicePage();
  });
  elements.clearFilters.addEventListener("click", clearFilters);
  elements.exportInvoices.addEventListener("click", exportCsv);
  elements.previousPage.addEventListener("click", () => changePage(-1));
  elements.nextPage.addEventListener("click", () => changePage(1));
  elements.copyInvoiceNumber.addEventListener("click", copyInvoiceNumber);
  elements.printInvoice.addEventListener("click", () => window.print());
  window.addEventListener("hashchange", () => {
    switchView(location.hash === "#invoices" ? "invoices" : "overview", false);
  });
}

async function handleLogin(event) {
  event.preventDefault();
  elements.loginError.textContent = "";
  state.apiKey = elements.apiKey.value.trim();
  if (!state.apiKey) return;

  try {
    await apiFetch("/api/ping.php");
    sessionStorage.setItem("salesApiKey", state.apiKey);
    showDashboard();
    switchView(state.currentView, false);
    await loadDashboard();
  } catch (error) {
    state.apiKey = "";
    elements.loginError.textContent =
      error.status === 401 ? "مفتاح الدخول غير صحيح." : "تعذر الاتصال بالخادم.";
  }
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

function switchView(view, updateHash = true) {
  state.currentView = view === "invoices" ? "invoices" : "overview";
  const invoicesActive = state.currentView === "invoices";
  elements.overviewView.hidden = invoicesActive;
  elements.invoicesView.hidden = !invoicesActive;
  elements.pageEyebrow.textContent = invoicesActive ? "إدارة المبيعات" : "لوحة التحكم";
  elements.pageTitle.textContent = invoicesActive ? "الفواتير" : "نظرة عامة على المبيعات";
  elements.navItems.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.currentView);
  });
  if (updateHash) {
    history.pushState(null, "", invoicesActive ? "#invoices" : "#overview");
  }
  if (invoicesActive) renderInvoicePage();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  const params = currentParams();

  try {
    const data = await apiFetch(`/api/dashboard?${params}`);
    state.invoices = data.invoices;
    renderSummary(data.summary);
    renderChart(data.daily_sales);
    renderProducts(data.top_products);
    renderRecentInvoices(data.invoices.slice(0, 4));
    renderInvoicePage();
    elements.lastUpdated.textContent = `آخر تحديث ${new Intl.DateTimeFormat("ar-EG", {
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date())}`;
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

function currentParams() {
  const params = new URLSearchParams();
  if (elements.searchInput.value.trim()) params.set("search", elements.searchInput.value.trim());
  if (elements.fromDate.value) params.set("from", elements.fromDate.value);
  if (elements.toDate.value) params.set("to", elements.toDate.value);
  return params;
}

function filtersChanged() {
  state.page = 1;
  elements.periodButtons.forEach((button) => button.classList.remove("active"));
  loadDashboard();
}

function clearFilters() {
  elements.searchInput.value = "";
  elements.fromDate.value = "";
  elements.toDate.value = "";
  elements.invoiceSort.value = "newest";
  state.page = 1;
  elements.periodButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.period === "all");
  });
  loadDashboard();
}

function applyPeriod(period) {
  const today = new Date();
  const to = localDate(today);
  let from = "";
  if (period === "today") from = to;
  if (period === "7" || period === "30") {
    const start = new Date(today);
    start.setDate(start.getDate() - (Number(period) - 1));
    from = localDate(start);
  }
  elements.fromDate.value = from;
  elements.toDate.value = period === "all" ? "" : to;
  elements.periodButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.period === period);
  });
  state.page = 1;
  loadDashboard();
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
        <div class="bar-track"><div class="bar" style="height:${height}%"></div></div>
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

function renderRecentInvoices(invoices) {
  if (!invoices.length) {
    elements.recentInvoices.innerHTML = emptyInline("لا توجد فواتير بعد");
    return;
  }
  elements.recentInvoices.innerHTML = invoices.map((invoice) => `
    <article class="recent-invoice">
      <button type="button" data-recent-id="${invoice.local_invoice_id}">
        فاتورة #${escapeHtml(invoice.local_invoice_id)}
      </button>
      <strong>${money(invoice.invoice_total)}</strong>
      <span>${escapeHtml(formatDate(invoice.invoice_date))} · ${number(invoice.item_count)} قطعة</span>
    </article>
  `).join("");
  elements.recentInvoices.querySelectorAll("[data-recent-id]").forEach((button) => {
    button.addEventListener("click", () => openInvoice(button.dataset.recentId));
  });
}

function sortedInvoices() {
  const invoices = [...state.invoices];
  const sort = elements.invoiceSort.value;
  if (sort === "oldest") invoices.reverse();
  if (sort === "highest") invoices.sort((a, b) => Number(b.invoice_total) - Number(a.invoice_total));
  if (sort === "lowest") invoices.sort((a, b) => Number(a.invoice_total) - Number(b.invoice_total));
  return invoices;
}

function renderInvoicePage() {
  if (!elements.invoiceRows) return;
  const invoices = sortedInvoices();
  const totalPages = Math.max(1, Math.ceil(invoices.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageInvoices = invoices.slice(start, start + state.pageSize);
  const total = invoices.reduce((sum, invoice) => sum + Number(invoice.invoice_total), 0);
  const largest = invoices.reduce((max, invoice) => Math.max(max, Number(invoice.invoice_total)), 0);

  elements.invoiceResultLabel.textContent = `${number(invoices.length)} فاتورة مطابقة`;
  elements.filteredInvoiceCount.textContent = number(invoices.length);
  elements.filteredInvoiceTotal.textContent = money(total);
  elements.largestInvoice.textContent = money(largest);
  elements.emptyState.hidden = pageInvoices.length > 0;
  elements.invoiceRows.innerHTML = pageInvoices.map((invoice) => `
    <tr>
      <td>
        <button class="invoice-link" type="button" data-invoice-id="${invoice.local_invoice_id}">
          #${escapeHtml(invoice.local_invoice_id)}
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

  elements.pageLabel.textContent = `صفحة ${number(state.page)} من ${number(totalPages)}`;
  elements.previousPage.disabled = state.page <= 1;
  elements.nextPage.disabled = state.page >= totalPages;
  elements.invoiceRows.querySelectorAll("[data-invoice-id]").forEach((button) => {
    button.addEventListener("click", () => openInvoice(button.dataset.invoiceId));
  });
  refreshIcons();
}

function changePage(change) {
  state.page += change;
  renderInvoicePage();
  elements.invoicesView.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function openInvoice(invoiceId) {
  try {
    const data = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}`);
    state.selectedInvoiceId = data.invoice.local_invoice_id;
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

async function copyInvoiceNumber() {
  if (!state.selectedInvoiceId) return;
  try {
    await navigator.clipboard.writeText(String(state.selectedInvoiceId));
    showToast("تم نسخ رقم الفاتورة.");
  } catch {
    showToast("تعذر نسخ رقم الفاتورة.");
  }
}

function exportCsv() {
  const invoices = sortedInvoices();
  if (!invoices.length) {
    showToast("لا توجد فواتير لتصديرها.");
    return;
  }
  const rows = [
    ["Invoice ID", "Date", "Items", "Total EGP"],
    ...invoices.map((invoice) => [
      invoice.local_invoice_id,
      invoice.invoice_date,
      invoice.item_count,
      Number(invoice.invoice_total).toFixed(2)
    ])
  ];
  const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `sales-invoices-${localDate(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
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

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
