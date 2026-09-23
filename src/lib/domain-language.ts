import { hasUnreviewedLanguages, languagePhrase, stateLanguages } from "./languages";
import { array, mask, object, string, type DomainError } from "./domain-data";
import type { ActionPlan } from "./domain-actions";
import type { DialogueState, JsonObject, Scenario } from "./types";

// Presentation only. The organizer's slots, prices, action plan and review hash
// remain unchanged; no model rewrites a confirmation summary.
export const turkishSlotQuestions: Record<string, string> = {
  phone: "Telefon numaranızı söyler misiniz?",
  iin: "12 haneli Kazakistan bireysel kimlik numaranızı (IIN) söyler misiniz?",
  policy_number: "Poliçe numaranız nedir?", claim_number: "Hasar başvuru numaranız nedir?",
  vehicle_plate: "Aracın plakası nedir?", culprit_vehicle_plate: "Kazaya neden olan aracın plakası nedir?",
  vehicle_type: "Araç türü nedir: otomobil, kamyon veya motosiklet?",
  region: "Araç hangi bölgede kayıtlı: Almatı, Astana veya başka bir bölge?",
  drivers_iin: "Poliçeye eklenecek tüm sürücülerin 12 haneli IIN numaralarını belirtir misiniz?",
  new_driver_iin: "Eklenecek sürücünün 12 haneli IIN numarası nedir?",
  car_value: "Aracın piyasa değeri kaç tenge?", car_year: "Aracın üretim yılı nedir?",
  franchise: "KASKO için kaç tenge muafiyet seçiyorsunuz?",
  product_type: "Hangi sigorta ürünü hakkında konuşuyoruz?",
  trip_country: "Hangi ülkeye seyahat edeceksiniz?", trip_start: "Seyahat hangi tarihte başlayacak?",
  trip_end: "Seyahat hangi tarihte bitecek?", travelers_count: "Kaç kişi seyahat edecek?",
  traveler_max_age: "En yaşlı yolcu kaç yaşında?", property_type: "Konut bir daire mi, müstakil ev mi?",
  property_address: "Sigortalanacak konutun adresi nedir?", sum_insured: "Kaç tenge sigorta bedeli seçiyorsunuz?",
  incident_date: "Olay hangi tarihte gerçekleşti?", incident_description: "Ne olduğunu kısaca anlatır mısınız?",
  injured: "Yaralanan biri var mı?", location: "Şu anda neredesiniz?", city: "Hangi şehirdesiniz?",
  email: "E-posta adresinizi belirtir misiniz?", contact_field: "Telefonu, e-posta adresini veya adresi mi değiştirmek istiyorsunuz?",
  new_value: "Yeni değer nedir?", payment_date: "Ödemeyi hangi tarihte yaptınız?", payment_amount: "Kaç tenge ödediniz?",
  callback_time: "Hangi zamanda geri aranmak istersiniz?", doctor_specialty: "Hangi uzmanlık alanındaki doktora görünmek istiyorsunuz?",
  service_name: "Hangi sağlık hizmetinin kapsamını kontrol edelim?", preferred_date: "Hangi tarihi tercih ediyorsunuz?",
  company_name: "Şirketin adı nedir?", employees_count: "Kaç çalışan sigortalanacak?",
  cancel_reason: "Poliçeyi hangi nedenle iptal etmek istiyorsunuz?", complaint_text: "Şikâyetinizi veya itirazınızı kısaca anlatır mısınız?",
  fraud_details: "Şüpheli kişi ne söyledi veya ne istedi?", document_type: "Hangi belgeyi istiyorsunuz?",
  topic: "Hangi koşulu açıklamamı istersiniz?", package: "Hangi KASKO programını seçiyorsunuz: Standard veya Lite?",
  term_months: "OGPO poliçesi 6 ay mı, 12 ay mı olsun?",
};

const phrases: Record<string, string> = {
  "Уточните недостающие данные.": "Eksik bilgileri netleştirir misiniz?",
  "Передать запрос и контекст специалисту": "Talebi ve konuşma bağlamını uzmana iletmek",
  "Могу передать запрос и контекст специалисту. Подтверждаете?": "Talebi ve konuşma bağlamını uzmana iletebilirim. Onaylıyor musunuz?",
  "Запрос и контекст переданы в очередь специалиста. Оператор сможет продолжить этот разговор.": "Talep ve konuşma bağlamı uzman kuyruğuna iletildi. Operatör bu görüşmeye devam edebilir.",
  "Разговор завершён; начните новый для следующего вопроса.": "Bu görüşme tamamlandı. Yeni bir soru için yeni görüşme başlatın.",
  "Передача отменена. Продолжим разговор здесь.": "Uzmana aktarma iptal edildi. Görüşmeye burada devam edelim.",
  "Передать запрос специалисту? Ответьте «да» или «нет».": "Talebi uzmana ileteyim mi? Evet veya hayır deyin.",
  "Спасибо за обращение. Всего доброго!": "Bize ulaştığınız için teşekkürler. İyi günler!",
  "Я помогаю с услугами страхования Saqta: авто, ДМС, поездки, имущество и несчастные случаи. Какой вопрос по этим услугам вас интересует?": "Saqta'nın araç, sağlık, seyahat, konut ve kaza sigortaları hakkında yardımcı oluyorum. Bu hizmetlerle ilgili ne sormak istersiniz?",
  "Уточните, пожалуйста: вам нужна информация, действие по полису или помощь со страховым случаем?": "Bilgi mi, poliçeyle ilgili bir işlem mi, yoksa bir hasar olayı için yardım mı istiyorsunuz?",
  "Действие отменено. Какие данные нужно изменить?": "İşlem iptal edildi. Hangi bilgileri değiştirmek istersiniz?",
  "Назовите телефон, ИИН, номер полиса или заявления для поиска клиента.": "Müşteriyi bulmak için telefon, IIN, poliçe veya hasar başvuru numarasını belirtin.",
  "Если есть пострадавшие, сразу звоните сто двенадцать. ": "Yaralanan varsa hemen 112'yi arayın. ",
  "Никому не сообщайте коды SMS и данные карты. ": "SMS kodlarını ve kart bilgilerini kimseyle paylaşmayın. ",
  "Никому не сообщайте SMS-коды, CVV и PIN. ": "SMS kodlarını, CVV ve PIN bilgilerini kimseyle paylaşmayın. ",
  "Электронная карта находится в приложении в разделе «Мои полисы». ": "Elektronik kart uygulamanın «Мои полисы» bölümündedir. ",
  "Условия изменились: ": "Koşullar değişti: ",
  "Подтверждаете?": "Onaylıyor musunuz? Evet veya hayır deyin.",
};

const mixedPhrases: Record<string, { ru_tr: string; kk_tr: string }> = {
  "Подтверждаете?": { ru_tr: "Подтверждаете? Evet veya hayır deyin.", kk_tr: "Растайсыз ба? Evet veya hayır deyin." },
  "Передать запрос и контекст специалисту": { ru_tr: "Передать запрос и контекст uzmana", kk_tr: "Сұраныс пен контекстті uzmana iletmek" },
  "Могу передать запрос и контекст специалисту. Подтверждаете?": { ru_tr: "Могу передать запрос и контекст uzmana. Onaylıyor musunuz?", kk_tr: "Сұраныс пен контекстті uzmana iletebilirim. Растайсыз ба?" },
  "Передать запрос специалисту? Ответьте «да» или «нет».": { ru_tr: "Передать запрос uzmana? Evet veya hayır deyin.", kk_tr: "Сұранысты uzmana берейін бе? Evet veya hayır deyin." },
  "Передача отменена. Продолжим разговор здесь.": { ru_tr: "Передача отменена. Buradan devam edelim.", kk_tr: "Маманға беру тоқтатылды. Buradan devam edelim." },
  "Действие отменено. Какие данные нужно изменить?": { ru_tr: "Действие отменено. Hangi bilgiyi değiştirelim?", kk_tr: "Әрекет тоқтатылды. Hangi bilgiyi değiştirelim?" },
  "Условия изменились: ": { ru_tr: "Условия değişti: ", kk_tr: "Шарттар değişti: " },
  "Назовите телефон, ИИН, номер полиса или заявления для поиска клиента.": { ru_tr: "Для поиска клиента telefon, IIN, poliçe veya başvuru numarasını belirtin.", kk_tr: "Клиентті табу үшін telefon, IIN, poliçe veya başvuru numarasını belirtin." },
  "Если есть пострадавшие, сразу звоните сто двенадцать. ": { ru_tr: "Если есть пострадавшие, hemen 112'yi arayın. ", kk_tr: "Зардап шеккендер болса, hemen 112'yi arayın. " },
};

/** Mixed TR pairs use only their actual languages; KK/TR never falls back to RU. */
export function domainPhrase(state: Pick<DialogueState, "language" | "responseLanguages">, ru: string, kk: string, ru_kk?: string, tr?: string): string {
  const languages = stateLanguages(state);
  // Internal factual source only: executeTurn replaces the durable fallback and
  // gives this exact text to the translation-only composer for other languages.
  if (hasUnreviewedLanguages(languages)) return ru || tr || kk;
  // An unreviewed future phrase must not erase facts or business conditions.
  const translated = tr ?? phrases[ru] ?? `Çevirisi bulunmayan kaynak metin: ${languages.includes("kk") && !languages.includes("ru") ? kk : ru}`;
  const mixed = mixedPhrases[ru];
  return languagePhrase(languages, {
    ru, kk, tr: translated, ru_kk,
    ru_tr: mixed?.ru_tr ?? `Кратко: ${translated}`,
    kk_tr: mixed?.kk_tr ?? `Қысқаша: ${translated}`,
    ru_kk_tr: ru === "Подтверждаете?" ? "Подтверждаете, растайсыз ба? Evet veya hayır deyin." : `Кратко, қысқаша: ${translated}`,
  });
}

const mixedQuestions: Record<string, { ru_tr: string; kk_tr: string }> = {
  phone: { ru_tr: "Номер телефона söyleyebilir misiniz?", kk_tr: "Телефон нөміріңізді söyleyebilir misiniz?" },
  iin: { ru_tr: "Назовите IIN, 12 haneli numarayı.", kk_tr: "12 таңбалы ЖСН-іңізді söyler misiniz?" },
  policy_number: { ru_tr: "Номер полиса nedir?", kk_tr: "Полис нөміріңіз nedir?" },
  claim_number: { ru_tr: "Номер заявления nedir?", kk_tr: "Өтініш нөміріңіз nedir?" },
  region: { ru_tr: "В каком регионе araç kayıtlı?", kk_tr: "Көлік қай өңірде kayıtlı?" },
  city: { ru_tr: "В каком городе, hangi şehir?", kk_tr: "Қай қаладасыз, hangi şehir?" },
  vehicle_type: { ru_tr: "Тип машины: otomobil, kamyon veya motosiklet?", kk_tr: "Көлік түрі: otomobil, kamyon veya motosiklet?" },
  package: { ru_tr: "Какую программу seçiyorsunuz: Standard veya Lite?", kk_tr: "Қай бағдарламаны seçiyorsunuz: Standard veya Lite?" },
  term_months: { ru_tr: "Срок 6 ay mı, 12 ay mı?", kk_tr: "Мерзімі 6 ay mı, 12 ay mı?" },
  preferred_date: { ru_tr: "Какую дату tercih edersiniz?", kk_tr: "Қай күнді tercih edersiniz?" },
  injured: { ru_tr: "Пострадавшие var mı?", kk_tr: "Зардап шеккендер var mı?" },
};

export function turkishSlotPrompt(state: DialogueState, slot: string, ru: string, kk: string, ru_kk?: string, options = ""): string {
  const tr = (turkishSlotQuestions[slot] ?? "Eksik bilgiyi belirtir misiniz?") + options;
  if (hasUnreviewedLanguages(stateLanguages(state))) return tr;
  const mixed = mixedQuestions[slot];
  return languagePhrase(stateLanguages(state), { ru, kk, tr, ru_kk,
    ru_tr: mixed ? mixed.ru_tr + options : `Уточните: ${tr}`,
    kk_tr: mixed ? mixed.kk_tr + options : `Нақтылаңызшы: ${tr}`,
    ru_kk_tr: `Уточните, нақтылаңызшы: ${tr}`,
  });
}

const scenarioNamesTr: Record<string, string> = {
  SC01: "OGPO fiyatı", SC02: "OGPO satın alma", SC03: "KASKO koşulları ve fiyatı", SC04: "Sürücü ekleme", SC05: "Araç veya plaka değişikliği",
  SC06: "Seyahat sigortası", SC07: "Konut sigortası", SC08: "Kaza sigortası", SC09: "Bireysel sağlık sigortası", SC10: "Kurumsal sigorta",
  SC11: "Yeni trafik kazası", SC12: "Kusurlu aracın OGPO poliçesinden hasar başvurusu", SC13: "KASKO hasarı", SC14: "Konut hasarı", SC15: "Yurt dışında sağlık olayı",
  SC16: "Kaza sonucu yaralanma", SC17: "Hasar başvurusunun durumu", SC18: "Hasar belgeleri", SC19: "Tazminat kararına itiraz", SC20: "Araç incelemesi",
  SC21: "Doktor randevusu", SC22: "Sağlık hizmeti kapsamı", SC23: "Anlaşmalı klinikler", SC24: "Elektronik sağlık kartı", SC25: "Poliçe geçerliliği",
  SC26: "Poliçe belgelerini yeniden gönderme", SC27: "Poliçe yenileme", SC28: "Poliçe iptali", SC29: "İletişim bilgilerini değiştirme", SC30: "Ödeme alındı, poliçe yok",
  SC31: "Ödeme yöntemleri", SC32: "Bonus-malus sınıfı", SC33: "Ofis bilgileri", SC34: "Uygulama yardımı", SC35: "Hizmet şikâyeti",
  SC36: "Geri arama", SC37: "Operatörle görüşme", SC38: "Şüpheli arama", SC39: "Belge talebi", SC40: "Poliçe koşulları",
};
export const turkishScenarioName = (scenario: Scenario): string => scenarioNamesTr[scenario.scenario_id] ?? scenario.name;

export function turkishConfirmation(scenario: Scenario, slots: JsonObject, plan: ActionPlan): string {
  return plan.results.filter(action => action.status === "preview").map(action => {
    const d = action.data;
    switch (action.name) {
      case "cancel_policy": return `${slots.policy_number} numaralı poliçeyi iptal etmek; hesaplanan iade ${d.refund_amount} tenge`;
      case "update_contact": return `${({ phone: "Telefon", email: "E-posta", address: "Adres" } as Record<string, string>)[string(slots.contact_field)] ?? string(slots.contact_field)} bilgisini değiştirmek: ${mask(string(slots.new_value))}`;
      case "create_policy": case "renew_policy": return `Poliçe ${action.name === "renew_policy" ? "yenileme" : "düzenleme"} başvurusunu kaydetmek; tutar ${d.price} tenge; ödeme henüz yapılmadı`;
      case "book_appointment": case "book_inspection": return `${slots.preferred_date} tarihi için ${action.name === "book_appointment" ? "doktor randevusu" : "araç incelemesi"} talebi oluşturmak; saati uzman onaylayacak`;
      case "create_claim": return `${slots.incident_date} tarihli sigorta olayını kaydetmek: ${mask(string(slots.incident_description))}`;
      case "create_dispute": return `${slots.claim_number} başvurusu için itiraz kaydetmek: ${mask(string(slots.complaint_text))}`;
      case "update_policy": return `${slots.policy_number} poliçesini değiştirmek: ${scenario.scenario_id === "SC04" ? `${mask(string(slots.new_driver_iin))} numaralı sürücüyü eklemek` : `araç plakası ${slots.vehicle_plate}`}; ${d.extra_premium === null ? "ek primi uzman hesaplayacak" : `ek prim ${d.extra_premium} tenge`}`;
      case "create_callback": return `${slots.callback_time} için geri arama talebini kaydetmek; zamanı uzman kararlaştıracak`;
      case "create_complaint": return `Şikâyeti kaydetmek: ${mask(string(slots.complaint_text))}`;
      case "report_fraud": return `Şüpheli iletişim bildirimini kaydetmek: ${mask(string(slots.fraud_details))}`;
      case "send_sms": return `${string(d.recipient)} için SMS talebini kaydetmek; gönderim hizmeti henüz bağlı değil`;
      case "resend_documents": case "request_document": return `${string(d.destination_masked)} için belge gönderme talebini kaydetmek; gönderim hizmeti henüz bağlı değil`;
      case "transfer_to_operator": return "Talebi ve konuşma bağlamını uzmana iletmek";
      default: return `${action.name} işlemini kaydetmek`;
    }
  }).join("; ");
}

const errors: Record<string, string> = {
  "Не удалось найти клиента по указанным данным.": "Verilen bilgilerle müşteri bulunamadı.",
  "Идентификатор не совпадает с текущим клиентом; для другого клиента начните новый разговор.": "Kimlik bilgisi bu müşteriyle eşleşmiyor; başka bir müşteri için yeni görüşme başlatın.",
  "Полис недоступен для текущего клиента.": "Bu poliçeye mevcut müşteri adına erişilemiyor.",
  "Доступен срок шесть или двенадцать месяцев.": "6 veya 12 aylık süre seçilebilir.",
  "Уточните программу: Standard или Lite.": "Programı belirtin: Standard veya Lite.",
  "Полис не действует на указанную дату; передам вопрос специалисту.": "Poliçe belirtilen tarihte geçerli değil; uzman incelemesi gerekiyor.",
  "Для расчёта нужны регион, тип автомобиля и ИИН водителей.": "Hesaplama için bölge, araç türü ve sürücülerin IIN numaraları gerekiyor.",
  "Возраст автомобиля не подходит для этой программы КАСКО.": "Aracın yaşı bu KASKO programına uygun değil.",
  "В каталоге нет тарифа для этого возраста автомобиля; нужен специалист.": "Katalogda bu araç yaşı için tarife yok; uzman gerekiyor.",
  "Уточните стоимость автомобиля.": "Aracın değerini belirtin.",
  "Проверьте даты: поездка должна начинаться не раньше даты кейса и заканчиваться после начала.": "Tarihleri kontrol edin: seyahat vaka tarihinden önce başlamamalı ve bitiş başlangıçtan sonra olmalı.",
  "Для путешественника старше семидесяти пяти лет оформление доступно через специалиста.": "75 yaşından büyük yolcular için işlemi uzman yapmalıdır.",
  "Не могу уверенно определить тарифную зону этой страны; передам специалисту.": "Bu ülkenin tarife bölgesini güvenilir biçimde belirleyemiyorum; uzman gerekiyor.",
  "Проверьте даты и число путешественников.": "Tarihleri ve yolcu sayısını kontrol edin.",
  "Для этой страховой суммы в программе нет тарифа.": "Programda bu sigorta bedeli için tarife yok.",
  "Для расчёта этого продукта требуется специалист.": "Bu ürünün hesaplaması için uzman gerekiyor.",
  "Не удалось создать уникальный номер. Передам специалисту.": "Benzersiz numara oluşturulamadı; uzman gerekiyor.",
  "По указанным данным запись не найдена.": "Verilen bilgilerle kayıt bulunamadı.",
  "Эта запись недоступна для идентифицированного клиента.": "Bu kayda tanımlanan müşteri adına erişilemiyor.",
  "Этот полис относится к другой программе страхования.": "Bu poliçe başka bir sigorta programına ait.",
  "Для медицинской услуги нужен полис ДМС.": "Bu sağlık hizmeti için DMS poliçesi gerekiyor.",
  "Этот полис нельзя продлить автоматически.": "Bu poliçe otomatik olarak yenilenemez.",
  "Для продления этого продукта нужны новые условия; передам специалисту.": "Bu ürünü yenilemek için yeni koşullar gerekiyor; uzman incelemeli.",
  "Изменение водителя или автомобиля доступно только для автополиса.": "Sürücü veya araç değişikliği yalnızca araç poliçelerinde yapılabilir.",
  "Этот водитель уже включён в полис.": "Bu sürücü poliçeye zaten eklenmiş.",
  "Этот полис уже расторгнут.": "Bu poliçe zaten iptal edilmiş.",
  "В данных нет оплаченной премии для расчёта возврата.": "İade hesaplamak için ödenmiş prim bilgisi bulunmuyor.",
  "Дата происшествия не может быть в будущем.": "Olay tarihi gelecekte olamaz.",
  "Выберите сегодняшнюю или будущую дату.": "Bugünü veya gelecekteki bir tarihi seçin.",
  "Эта медицинская услуга не входит в программу полиса.": "Bu sağlık hizmeti poliçenin kapsamında değil.",
  "В каталоге нет подходящей клиники в этом городе; передам запрос специалисту.": "Katalogda bu şehir için uygun klinik bulunmuyor; uzman gerekiyor.",
  "Можно изменить телефон, почту или адрес.": "Telefon, e-posta veya adres değiştirilebilir.",
  "Этот номер уже связан с другим профилем.": "Bu numara başka bir profile bağlı.",
  "Действие отсутствует в исполнительном модуле.": "Bu işlem yürütme modülünde bulunmuyor.",
};

export function domainErrorText(state: DialogueState, error: DomainError): string {
  const tr = errors[error.ru] ?? (error.code === "invalid_input" && error.ru.startsWith("Не удалось проверить значение:")
    ? `Girilen değer doğrulanamadı. ${turkishSlotQuestions[error.slot ?? ""] ?? "Lütfen bilgiyi düzeltin."}`
    : `Çevirisi bulunmayan kaynak açıklaması: ${stateLanguages(state).includes("kk") && !stateLanguages(state).includes("ru") ? error.kk : error.ru}`);
  return domainPhrase(state, error.ru, error.kk, undefined, tr);
}

const statusTr: Record<string, string> = { active: "geçerli", expired: "süresi dolmuş", not_yet_active: "henüz başlamadı", cancelled: "iptal edildi", pending_payment: "ödeme bekliyor", paid: "ödendi", approved: "onaylandı", documents_requested: "belge bekliyor", under_review: "incelemede", registered: "kaydedildi", charged_policy_not_issued: "ücret alındı, poliçe düzenlenmedi" };

function factualNoteTr(note: string): string {
  const reviewed: Record<string, string> = {
    "Submit supporting documents for review": "İnceleme için destekleyici belgeleri yükleyin.",
    "Upload the act from the building management company; review starts after that.": "Bina yönetiminin tutanağını yükleyin; inceleme bundan sonra başlayacak.",
    "MRI and CT by referral, up to 2 per year": "MR ve BT sevkle, yılda en fazla 2 kez karşılanır.",
    "Dental treatment (caries, extraction); prosthetics and implants excluded": "Diş tedavisi (çürük, çekim) karşılanır; protez ve implantlar kapsam dışıdır.",
    "Lab tests require a doctor's referral; Basic covers basic tests only": "Laboratuvar testleri için doktor sevki gerekir; Basic yalnızca temel testleri karşılar.",
    "Specialists require a therapist referral": "Uzman muayenesi için terapist sevki gerekir.",
    "Specialists without referral": "Uzman muayenesi için sevk gerekmez.",
  };
  if (reviewed[note]) return reviewed[note];
  const due = /^All documents received\. Decision due by (\d{4}-\d{2}-\d{2}), the client will get an SMS\.$/.exec(note);
  if (due) return `Tüm belgeler alındı. Karar tarihi ${due[1]}; kaynak kayıtta müşteriye SMS bildirimi öngörülüyor.`;
  const paid = /^Payout completed on (\d{4}-\d{2}-\d{2})\.$/.exec(note);
  if (paid) return `Tazminat ödemesi ${paid[1]} tarihinde tamamlandı.`;
  const planned = /^Payout of ([\d ]+) KZT scheduled for (\d{4}-\d{2}-\d{2})\. The amount follows the insurer's independent assessment; the service station estimate was ([\d ]+) KZT\.$/.exec(note);
  if (planned) return `${planned[1]} KZT ödeme ${planned[2]} tarihine planlandı. Tutar sigortacının bağımsız değerlendirmesine dayanıyor; servisin tahmini ${planned[3]} KZT idi.`;
  // Future free-text notes remain verbatim until the optional factual composer
  // translates them. Never replace a condition or amount with a generic claim.
  return note;
}

/** Factual fallback remains Turkish even if the optional composer is unavailable. */
export function turkishFallback(scenario: Scenario, plan: ActionPlan): string {
  const find = (name: string) => object(plan.facts[name]);
  if (plan.handoff) {
    const manual = object(plan.facts.manual_fulfillment);
    return manual.request_id ? `${manual.request_id} talebi kaydedildi ve uzmana iletildi. Saat ve dış hizmetin gerçekleşmesi henüz onaylanmadı.`
      : "Talep ve konuşma bağlamı uzman kuyruğuna kaydedildi. Operatör görüşmeye burada devam edebilir.";
  }
  const quote = plan.results.find(action => action.name.startsWith("calc_") && action.name.endsWith("_price"));
  switch (scenario.scenario_id) {
    case "SC01": case "SC03": case "SC07": case "SC08": return `Program koşullarına göre tutar ${quote?.data.price} tenge. Hesaplama görüşme geçmişine kaydedildi.`;
    case "SC02": case "SC06": case "SC27": { const d = find(scenario.scenario_id === "SC27" ? "renew_policy" : "create_policy"); return `${d.policy_number} başvurusu kaydedildi; tutar ${d.price} tenge. Poliçe ödeme bekliyor; ödeme bağlantısı henüz mevcut değil.`; }
    case "SC04": case "SC05": return `Poliçe değişikliği kaydedildi. ${find("update_policy").extra_premium === null ? "Ek primi uzman incelemeli." : "Ek prim gerekmiyor."}`;
    case "SC11": return "Yaralanan varsa 112'yi arayın; dörtlüleri yakın ve uyarı üçgenini yerleştirin. Kaza yerini fotoğraflayın ve kayıt tamamlanana kadar araçları hareket ettirmeyin.";
    case "SC12": case "SC13": case "SC14": case "SC16": return `${find("create_claim").claim_number} başvurusu kaydedildi. Belgeler uygulamadaki «Мои заявления» bölümüne yüklenebilir.`;
    case "SC17": { const d = find("get_claim"); return `${d.claim_number} başvurusunun durumu: ${statusTr[string(d.status)] ?? string(d.status)}. ${factualNoteTr(string(d.next_step))}`; }
    case "SC19": return `${find("create_dispute").ticket_id} itirazı kaydedildi. Kurallara göre inceleme süresi 15 iş günüdür.`;
    case "SC20": case "SC21": return "Randevu talebi kaydedildi. Saat henüz onaylanmadı; uzman sizinle kararlaştıracak.";
    case "SC22": { const d = find("check_coverage"); return d.covered === true ? `Hizmet ${d.package} programında kapsanıyor; program koşulları geçerlidir. ${factualNoteTr(string(d.note))}` : d.covered === false ? "Hizmet DMS programınızın kapsamında değil." : "Katalogda bu hizmet için yeterli bilgi yok; uzman incelemesi gerekiyor."; }
    case "SC23": return `Şehrinizdeki klinikler: ${array(find("list_clinics").clinics).map(c => string(object(c).name)).join(", ")}. Adresler sonuç ayrıntılarında yer alıyor.`;
    case "SC24": return "Elektronik kart uygulamanın «Мои полисы» bölümündedir. SMS talebi kaydedildi; gönderim henüz doğrulanmadı.";
    case "SC25": { const d = find("get_policy"); return `${d.policy_number} poliçesi: ${statusTr[string(d.status)] ?? string(d.status)}; bitiş tarihi ${d.end_date}.`; }
    case "SC26": case "SC39": return "Belge gönderme talebi kuyruğa kaydedildi. Teslimat henüz doğrulanmadı.";
    case "SC28": return `Poliçe iptal edildi; hesaplanan iade ${find("cancel_policy").refund_amount} tenge. Para iadesi işleme alınmayı bekliyor.`;
    case "SC29": return "İletişim bilgileri güncellendi ve kaydedildi.";
    case "SC30": { const d = find("check_payment"); return `Ödeme bulundu: ${d.amount} tenge; durum: ${statusTr[string(d.payment_status)] ?? string(d.payment_status)}.`; }
    case "SC32": return `Bonus-malus sınıfınız ${find("get_bm_class").bm_class}. Kusurlu olmadığınız kazasız bir yılda bir artar; kusurlu kazadan sonra iki azalır.`;
    case "SC33": return `Ofis: ${find("get_offices").address}. Çalışma saatleri: ${find("get_offices").hours}.`;
    case "SC35": return `${find("create_complaint").ticket_id} şikâyeti kaydedildi. Yanıt süresi 15 iş günüdür.`;
    case "SC36": return `${find("create_callback").callback_time} için geri arama talebi kaydedildi. Zaman uzman onayını bekliyor.`;
    case "SC38": return "Şüpheli arama bildirimi kaydedildi. SMS kodlarını, CVV ve PIN bilgilerini kimseyle paylaşmayın.";
    case "SC09": return "Yıllık DMS Basic 180000 tenge, Comfort 320000 tenge. Comfort ayrıca diş tedavisini ve sevkle yılda iki MR incelemesini kapsar.";
    case "SC31": return "Kartla, ödeme bağlantısıyla, şirketler için banka havalesiyle veya ofis terminalinden ödeme yapılabilir. KASKO'da iki ya da dört, bireysel DMS'de iki taksit seçeneği vardır.";
    case "SC34": return "Uygulamaya telefon ve tek kullanımlık SMS koduyla giriş yapılır. Kod gelmediyse numarayı kontrol edin, 60 saniye bekleyip tekrar isteyin; saatte en fazla beş kod alınabilir.";
    default: return "Program kurallarındaki bilgiler sorgu sonucunda bulunuyor. Yalnızca sağlanan bilgi tabanını kullanıyorum.";
  }
}
