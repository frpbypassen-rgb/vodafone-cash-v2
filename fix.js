const fs = require('fs');
let c = fs.readFileSync('d:/vodafone-cash-system/routes/executorPortal.js', 'utf8');

const replacement = `                            }
                        }
                    }
                }
            } catch (e) {}
        };

        const [clientFileIds] = await Promise.all([sendToClientTask(), sendToAdminTask()]);

        tx.status = 'completed'; 
        if (typeof localFileNames !== 'undefined' && localFileNames.length > 0) {
            tx.proofImage = localFileNames[0]; 
            tx.proofImages = localFileNames; 
        } else if (clientFileIds && clientFileIds.length > 0) {
            tx.proofImage = clientFileIds[0]; 
            tx.proofImages = clientFileIds; 
        }
        tx.updatedAt = new Date();

        const execTime = new Date().toLocaleString('en-GB');
        const completionMsg = \`✅ <b>تـم الـتـنـفـيـذ بـنـجـاح</b>\\n\\n\` +
                              \`🧾 <b>الطلب:</b> <code>\${tx.customId || tx._id}</code>\\n\` +
                              \`📞 <b>الرقم/الحساب:</b>\`;`;

// Find the bad snippet
c = c.replace(/                            }\r?\n                        }\r?\n                    }\r?\n                }\r?\n                              `📞 <b>الرقم\/الحساب:<\/b>/, replacement);

fs.writeFileSync('d:/vodafone-cash-system/routes/executorPortal.js', c);
console.log('Fixed!');
