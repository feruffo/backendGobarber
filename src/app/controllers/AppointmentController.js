import * as Yup from 'yup';
import { startOfHour, parseISO, isBefore, format, subHours } from 'date-fns';
import pt from 'date-fns/locale/pt';
import User from '../models/User';
import File from '../models/File';
import Appointment from '../models/Appointment';
import Notification from '../schemas/Notification';

import CancellationMail from '../jobs/CancellationMail';
import Queue from '../../lib/Queue';

class AppointmentController {
  async index(req, res) {
    const { page } = req.query;

    const appointments = await Appointment.findAll({
      where: { user_id: req.userId, canceled_at: null },
      order: ['date'],
      limit: 20,
      offset: (page - 1) * 20,
      attributes: ['id', 'date', 'past', 'cancelable'],
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['id', 'name'],
          include: [
            {
              model: File,
              as: 'avatar',
              attributes: ['id', 'path', 'url'],
            },
          ],
        },
      ],
    });
    return res.json(appointments);
  }

  async store(req, res) {
    const schema = Yup.object().shape({
      provider_id: Yup.number().required(),
      date: Yup.date().required(),
    });
    if (!(await schema.isValid(req.body))) {
      return res.state(400).json({ error: 'Validação Falhou!' });
    }

    const { provider_id, date } = req.body;

    /**
     * verifica se o provider_id é um provider
     */
    const isProvider = await User.findOne({
      where: { id: provider_id, provider: true },
    });

    if (!isProvider) {
      return res.status(401).json({
        error: 'Agendamentos só podem ser criados por prestador de serviço',
      });
    }

    if (req.userId === provider_id) {
      return res.status(401).json({
        error:
          'Agendamentos só podem ser criados por prestador de serviço diferentes',
      });
    }

    const hourStart = startOfHour(parseISO(date));

    /**
     * checa se a data marcada n]ao é anterior ao dia de cadastro
     */
    if (isBefore(hourStart, new Date())) {
      return res
        .status(400)
        .json({ error: 'Datas passadas não são permitidas!' });
    }

    /**
     * checa se a data esta disponivel
     */

    const checkAvailability = await Appointment.findOne({
      where: {
        provider_id,
        canceled_at: null,
        date: hourStart, // ou a data pra real que foi gravada pra saber c ja tem;
      },
    });

    if (checkAvailability) {
      return res.status(400).json({ error: 'Horario não está vago!' });
    }

    const appointment = await Appointment.create({
      user_id: req.userId,
      provider_id,
      date,
    });

    /**
     * Notificação do Usuário
     */

    const user = await User.findByPk(req.userId);
    const formattedDate = format(
      hourStart,
      "'dia' dd 'de' MMMM', às' H:mm'h'",
      { locale: pt }
    );

    await Notification.create({
      content: `Novo agendamento de ${user.name} para o ${formattedDate} `,
      user: provider_id,
    });

    return res.json(appointment);
  }

  async delete(req, res) {
    const appointment = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['name', 'email'],
        },
        {
          model: User,
          as: 'user',
          attributes: ['name'],
        },
      ],
    });
    if (appointment.user_id !== req.userId) {
      return res.status(401).json({
        error: 'Você não tem permissão para cancelar esse agendamento',
      });
    }

    // verifica se o horario que a pessoa quer cancelar esta ate 2 horas antes do horario marcado
    const dateWithSub = subHours(appointment.date, 2);

    if (isBefore(dateWithSub, new Date())) {
      return res.status(401).json({
        error:
          'Você só pode cancelar um agendamento com até duas horas de antecedência',
      });
    }

    appointment.canceled_at = new Date();

    await appointment.save();

    await Queue.add(CancellationMail.key, {
      // cria a fila de job para enviar email
      appointment,
    });

    return res.json(appointment);
  }
}

export default new AppointmentController();
