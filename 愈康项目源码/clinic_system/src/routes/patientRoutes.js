const asyncRoute = require('../utils/asyncRoute');
const authService = require('../services/authService');
const patientService = require('../services/patientService');
const visitService = require('../services/visitService');

module.exports = function registerPatientRoutes(app) {
    app.post('/api/patients/migrate', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await patientService.migrate(req.currentUser));
    }));

    app.delete('/api/outpatients/:id', authService.authMiddleware, asyncRoute(async (req, res) => {
        res.json(await patientService.deleteOutpatient(req.currentUser, req.params.id));
    }));

    app.put('/api/outpatients/:id/visit', authService.authMiddleware, asyncRoute(async (req, res) => {
        const result = await visitService.updateSavedVisit(req.currentUser, req.params.id, req.body);
        res.json({ success: true, ...result });
    }));
};
